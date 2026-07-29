import assert from "node:assert/strict";
import test from "node:test";
import { Role } from "@prisma/client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "database E2E covers registration through payout and review",
  { skip: !testDatabaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.ENABLE_DEMO_LOGIN = "true";

    const { app, prisma } = await import("./server.js");

    const clearDatabase = async () => {
      await prisma.auditEvent.deleteMany();
      await prisma.notification.deleteMany();
      await prisma.orderStatusHistory.deleteMany();
      await prisma.qualityCheck.deleteMany();
      await prisma.proofAsset.deleteMany();
      await prisma.review.deleteMany();
      await prisma.payment.deleteMany();
      await prisma.aiEvent.deleteMany();
      await prisma.dispute.deleteMany();
      await prisma.order.deleteMany();
      await prisma.session.deleteMany();
      await prisma.user.deleteMany();
      await prisma.serviceCatalog.deleteMany();
    };

    const authHeaders = (token: string) => ({
      authorization: `Bearer ${token}`
    });

    try {
      await clearDatabase();
      await prisma.serviceCatalog.create({
        data: {
          id: "standard_apartment",
          title: "Standard apartment cleaning",
          basePrice: 18_000,
          durationMinutes: 150,
          mvp: true
        }
      });

      const suffix = Date.now();
      const registerClient = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          name: "E2E Client",
          email: `client-${suffix}@example.test`,
          password: "password1",
          role: "CLIENT"
        }
      });
      assert.equal(registerClient.statusCode, 200, registerClient.body);
      const clientAuth = registerClient.json();

      const registerExecutor = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          name: "E2E Executor",
          email: `executor-${suffix}@example.test`,
          password: "password1",
          role: "EXECUTOR"
        }
      });
      assert.equal(registerExecutor.statusCode, 200, registerExecutor.body);
      const executorAuth = registerExecutor.json();

      const crossClientAccess = await app.inject({
        method: "GET",
        url: `/clients/${executorAuth.user.id}/orders`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(crossClientAccess.statusCode, 403, crossClientAccess.body);
      assert.equal(crossClientAccess.json().error.code, "RESOURCE_FORBIDDEN");

      await prisma.user.createMany({
        data: [
          {
            name: "E2E Quality",
            email: `quality-${suffix}@example.test`,
            role: Role.QUALITY_MANAGER
          },
          {
            name: "E2E Operator",
            email: `operator-${suffix}@example.test`,
            role: Role.OPERATOR
          }
        ]
      });

      const qualityLogin = await app.inject({
        method: "POST",
        url: "/auth/demo-login",
        payload: { role: "QUALITY_MANAGER" }
      });
      assert.equal(qualityLogin.statusCode, 200, qualityLogin.body);
      const qualityAuth = qualityLogin.json();

      const operatorLogin = await app.inject({
        method: "POST",
        url: "/auth/demo-login",
        payload: { role: "OPERATOR" }
      });
      assert.equal(operatorLogin.statusCode, 200, operatorLogin.body);
      const operatorAuth = operatorLogin.json();

      const created = await app.inject({
        method: "POST",
        url: "/orders",
        headers: authHeaders(clientAuth.token),
        payload: {
          clientId: clientAuth.user.id,
          serviceId: "standard_apartment",
          address: "Almaty, Abay 1",
          areaSqm: 45,
          rooms: 2,
          hasPets: false,
          urgent: false,
          scheduledAt: "2026-08-01T09:00:00.000Z"
        }
      });
      assert.equal(created.statusCode, 200, created.body);
      const orderId = created.json().order.id as string;
      assert.equal(created.json().order.status, "PRICED");

      const intent = await app.inject({
        method: "POST",
        url: "/payments/intent",
        headers: {
          ...authHeaders(clientAuth.token),
          "idempotency-key": `e2e-${suffix}`
        },
        payload: { orderId, method: "kaspi_placeholder" }
      });
      assert.equal(intent.statusCode, 200, intent.body);

      const confirmed = await app.inject({
        method: "POST",
        url: `/payments/${intent.json().payment.id}/confirm`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      assert.equal(confirmed.json().order.status, "CONFIRMED");

      const prematureExecutorProgress = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/status`,
        headers: authHeaders(executorAuth.token),
        payload: { status: "ACCEPTED" }
      });
      assert.equal(prematureExecutorProgress.statusCode, 403, prematureExecutorProgress.body);
      assert.equal(prematureExecutorProgress.json().error.code, "ORDER_EXECUTOR_REQUIRED");

      const clientPayoutAttempt = await app.inject({
        method: "POST",
        url: `/payments/release/${orderId}`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(clientPayoutAttempt.statusCode, 403, clientPayoutAttempt.body);
      assert.equal(clientPayoutAttempt.json().error.code, "ROLE_FORBIDDEN");

      const assigned = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/assign`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(assigned.statusCode, 200, assigned.body);
      assert.equal(assigned.json().order.executorId, executorAuth.user.id);

      for (const status of ["ACCEPTED", "IN_PROGRESS"]) {
        const progressed = await app.inject({
          method: "POST",
          url: `/orders/${orderId}/status`,
          headers: authHeaders(executorAuth.token),
          payload: { status }
        });
        assert.equal(progressed.statusCode, 200, progressed.body);
        assert.equal(progressed.json().order.status, status);
      }

      const proof = await app.inject({
        method: "POST",
        url: "/quality/proof",
        headers: authHeaders(executorAuth.token),
        payload: {
          orderId,
          executorId: executorAuth.user.id,
          photoUri: "content://e2e/proof.png",
          photoBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6N8AAAAASUVORK5CYII=",
          fileName: "proof.png",
          mimeType: "image/png",
          notes: "E2E proof",
          checklist: ["Kitchen", "Bathroom", "Floors"]
        }
      });
      assert.equal(proof.statusCode, 200, proof.body);
      assert.equal(proof.json().order.status, "QUALITY_CHECK");

      const executorQualityAttempt = await app.inject({
        method: "POST",
        url: `/quality/${orderId}/complete`,
        headers: authHeaders(executorAuth.token),
        payload: { approved: true, score: 100 }
      });
      assert.equal(executorQualityAttempt.statusCode, 403, executorQualityAttempt.body);
      assert.equal(executorQualityAttempt.json().error.code, "ROLE_FORBIDDEN");

      const quality = await app.inject({
        method: "POST",
        url: `/quality/${orderId}/complete`,
        headers: authHeaders(qualityAuth.token),
        payload: { approved: true, score: 95, notes: "Approved by E2E" }
      });
      assert.equal(quality.statusCode, 200, quality.body);
      assert.equal(quality.json().order.status, "COMPLETED");

      const payout = await app.inject({
        method: "POST",
        url: `/payments/release/${orderId}`,
        headers: authHeaders(operatorAuth.token)
      });
      assert.equal(payout.statusCode, 200, payout.body);
      assert.equal(payout.json().order.status, "PAYMENT_RELEASED");

      const reviewPayload = {
        orderId,
        clientId: clientAuth.user.id,
        rating: 5,
        comment: "E2E complete"
      };
      const review = await app.inject({
        method: "POST",
        url: "/reviews",
        headers: authHeaders(clientAuth.token),
        payload: reviewPayload
      });
      assert.equal(review.statusCode, 200, review.body);

      const duplicateReview = await app.inject({
        method: "POST",
        url: "/reviews",
        headers: authHeaders(clientAuth.token),
        payload: reviewPayload
      });
      assert.equal(duplicateReview.statusCode, 409, duplicateReview.body);
      assert.equal(duplicateReview.json().error.code, "REVIEW_ALREADY_EXISTS");

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" }
      });
      assert.deepEqual(
        history.map((item) => item.toStatus),
        [
          "PRICED",
          "CONFIRMED",
          "ASSIGNED",
          "ACCEPTED",
          "IN_PROGRESS",
          "QUALITY_CHECK",
          "COMPLETED",
          "PAYMENT_RELEASED"
        ]
      );

      const logout = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(logout.statusCode, 200, logout.body);
      const revokedSession = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(revokedSession.statusCode, 401, revokedSession.body);
      assert.equal(revokedSession.json().error.code, "AUTH_REQUIRED");

      await prisma.session.updateMany({
        where: { userId: executorAuth.user.id },
        data: { expiresAt: new Date(0) }
      });
      const expiredSession = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: authHeaders(executorAuth.token)
      });
      assert.equal(expiredSession.statusCode, 401, expiredSession.body);
      assert.equal(expiredSession.json().error.code, "AUTH_REQUIRED");
    } finally {
      await clearDatabase();
      await app.close();
      await prisma.$disconnect();
    }
  }
);
