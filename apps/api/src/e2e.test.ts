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
      await prisma.pushDevice.deleteMany();
      await prisma.executorProfile.deleteMany();
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
          basePrice: 3_000,
          durationMinutes: 150,
          mvp: true
        }
      });

      const suffix = Date.now();
      const clientPassword = "E2E-client-password-1";
      const changedClientPassword = "E2E-client-password-2";
      const executorPassword = "E2E-executor-password-1";
      const registerClient = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          name: "E2E Client",
          email: `client-${suffix}@example.test`,
          password: clientPassword,
          role: "CLIENT"
        }
      });
      assert.equal(registerClient.statusCode, 200, registerClient.body);
      const clientAuth = registerClient.json();

      const updatedProfile = await app.inject({
        method: "PATCH",
        url: "/users/me/profile",
        headers: authHeaders(clientAuth.token),
        payload: {
          name: "E2E Client Updated",
          email: clientAuth.user.email,
          phone: "+79990000001"
        }
      });
      assert.equal(updatedProfile.statusCode, 200, updatedProfile.body);
      assert.equal(updatedProfile.json().user.name, "E2E Client Updated");
      assert.equal(updatedProfile.json().user.phone, "+79990000001");

      const secondClientLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          identifier: clientAuth.user.email,
          password: clientPassword
        }
      });
      assert.equal(secondClientLogin.statusCode, 200, secondClientLogin.body);
      const secondClientAuth = secondClientLogin.json();

      const invalidCurrentPassword = await app.inject({
        method: "PATCH",
        url: "/users/me/password",
        headers: authHeaders(clientAuth.token),
        payload: {
          currentPassword: "Wrong-current-password-1",
          newPassword: changedClientPassword
        }
      });
      assert.equal(invalidCurrentPassword.statusCode, 401, invalidCurrentPassword.body);
      assert.equal(invalidCurrentPassword.json().error.code, "AUTH_CURRENT_PASSWORD_INVALID");

      const reusedPassword = await app.inject({
        method: "PATCH",
        url: "/users/me/password",
        headers: authHeaders(clientAuth.token),
        payload: {
          currentPassword: clientPassword,
          newPassword: clientPassword
        }
      });
      assert.equal(reusedPassword.statusCode, 409, reusedPassword.body);
      assert.equal(reusedPassword.json().error.code, "PASSWORD_REUSE");

      const changedPassword = await app.inject({
        method: "PATCH",
        url: "/users/me/password",
        headers: authHeaders(clientAuth.token),
        payload: {
          currentPassword: clientPassword,
          newPassword: changedClientPassword
        }
      });
      assert.equal(changedPassword.statusCode, 200, changedPassword.body);
      assert.equal(changedPassword.json().ok, true);
      assert.equal(changedPassword.json().revokedSessions, 1);

      const currentSessionStillValid = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(currentSessionStillValid.statusCode, 200, currentSessionStillValid.body);

      const secondSessionRevoked = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: authHeaders(secondClientAuth.token)
      });
      assert.equal(secondSessionRevoked.statusCode, 401, secondSessionRevoked.body);

      const oldPasswordRejected = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          identifier: clientAuth.user.email,
          password: clientPassword
        }
      });
      assert.equal(oldPasswordRejected.statusCode, 401, oldPasswordRejected.body);

      const changedPasswordAccepted = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          identifier: clientAuth.user.email,
          password: changedClientPassword
        }
      });
      assert.equal(changedPasswordAccepted.statusCode, 200, changedPasswordAccepted.body);

      const registerExecutor = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          name: "E2E Executor",
          email: `executor-${suffix}@example.test`,
          password: executorPassword,
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

      const activatedExecutor = await app.inject({
        method: "PATCH",
        url: `/operations/executors/${executorAuth.user.id}`,
        headers: authHeaders(operatorAuth.token),
        payload: {
          verified: true,
          active: true,
          acceptingJobs: true,
          serviceZones: ["ALMATY_CORE"]
        }
      });
      assert.equal(activatedExecutor.statusCode, 200, activatedExecutor.body);

      const heartbeat = await app.inject({
        method: "POST",
        url: "/executors/me/heartbeat",
        headers: authHeaders(executorAuth.token)
      });
      assert.equal(heartbeat.statusCode, 200, heartbeat.body);
      assert.equal(heartbeat.json().eligible, true);

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
          serviceZone: "ALMATY_CORE",
          scheduledAt: "2026-08-01T09:00:00.000Z"
        }
      });
      assert.equal(created.statusCode, 200, created.body);
      const orderId = created.json().order.id as string;
      assert.equal(created.json().order.status, "PRICED");

      const confirmedAndAssigned = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/confirm-placeholder`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(confirmedAndAssigned.statusCode, 200, confirmedAndAssigned.body);
      assert.equal(confirmedAndAssigned.json().order.status, "ASSIGNED");
      assert.equal(confirmedAndAssigned.json().order.executorId, executorAuth.user.id);
      assert.equal(confirmedAndAssigned.json().payment.status, "PAID");
      assert.equal(confirmedAndAssigned.json().payment.kind, "CLIENT_KASPI_PLACEHOLDER");

      const idempotentConfirm = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/confirm-placeholder`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(idempotentConfirm.statusCode, 200, idempotentConfirm.body);
      assert.equal(idempotentConfirm.json().order.status, "ASSIGNED");

      const executorTasksOnSecondAccount = await app.inject({
        method: "GET",
        url: `/performer/tasks/${executorAuth.user.id}`,
        headers: authHeaders(executorAuth.token)
      });
      assert.equal(executorTasksOnSecondAccount.statusCode, 200, executorTasksOnSecondAccount.body);
      assert.ok(
        executorTasksOnSecondAccount.json().some((order: { id: string }) => order.id === orderId),
        "the assigned order must be visible to the executor account"
      );

      const prematureExecutorProgress = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/status`,
        headers: authHeaders(executorAuth.token),
        payload: { status: "ACCEPTED" }
      });
      assert.equal(prematureExecutorProgress.statusCode, 200, prematureExecutorProgress.body);
      assert.equal(prematureExecutorProgress.json().order.status, "ACCEPTED");

      const clientPayoutAttempt = await app.inject({
        method: "POST",
        url: `/payments/release/${orderId}`,
        headers: authHeaders(clientAuth.token)
      });
      assert.equal(clientPayoutAttempt.statusCode, 403, clientPayoutAttempt.body);
      assert.equal(clientPayoutAttempt.json().error.code, "ROLE_FORBIDDEN");

      for (const status of ["IN_PROGRESS"]) {
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
          beforePhotoUri: "content://e2e/before.png",
          beforePhotoBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6N8AAAAASUVORK5CYII=",
          beforeFileName: "before.png",
          beforeMimeType: "image/png",
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
      assert.equal(proof.json().qualityCheck.score, null);
      assert.equal(proof.json().aiAnalysis.quality.data.manualReviewRequired, true);

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
