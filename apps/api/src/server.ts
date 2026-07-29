import cors from "@fastify/cors";
import {
  DisputeStatus,
  OrderStatus,
  PaymentKind,
  PaymentStatus,
  Prisma,
  PrismaClient,
  QualityCheckStatus,
  Role,
  User
} from "@prisma/client";
import Fastify from "fastify";
import { z } from "zod";
import { estimateOrderPrice, scoreExecutor } from "@ai-cleaning/shared";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { appConfig, corsOrigin, demoLoginEnabled } from "./config.js";
import {
  ANALYTICS_ROLES,
  OPERATION_ROLES,
  QUALITY_ROLES,
  assertExecutorProgress,
  assertOrderTransition,
  orderScopeForRole,
  TransitionContext
} from "./domain.js";
import { apiError, installErrorHandling } from "./errors.js";
import { decodeAndValidateProofImage, extensionForProofMimeType } from "./media.js";

export const prisma = new PrismaClient();
export const app = Fastify({
  logger: true,
  bodyLimit: appConfig.requestBodyLimitBytes,
  requestIdHeader: "x-request-id"
});
const proofStorageDir = new URL("../storage/proofs/", import.meta.url);

installErrorHandling(app);

await app.register(cors, {
  origin: corsOrigin()
});

const demoLoginSchema = z.object({
  role: z
    .enum(["CLIENT", "EXECUTOR", "OPERATOR", "QUALITY_MANAGER", "MANAGER", "ADMIN"])
    .default("CLIENT")
});

const authRoleSchema = z.enum(["CLIENT", "EXECUTOR"]);

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
  password: z.string().min(6),
  role: authRoleSchema.default("CLIENT")
}).refine((value) => value.email || value.phone, {
  message: "Email or phone is required"
});

const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(6)
});

const createOrderSchema = z.object({
  clientId: z.string(),
  serviceId: z.string(),
  address: z.string().min(3),
  areaSqm: z.number().int().positive(),
  rooms: z.number().int().positive(),
  hasPets: z.boolean().default(false),
  urgent: z.boolean().default(false),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  serviceZone: z.string().optional(),
  scheduledAt: z.string().datetime().optional()
});

const geocodeSchema = z.object({
  address: z.string().min(3)
});

const createPaymentSchema = z.object({
  orderId: z.string(),
  method: z.enum(["cash", "card", "kaspi_placeholder"]).default("kaspi_placeholder")
});

const paymentKindByMethod = {
  cash: PaymentKind.CLIENT_CASH,
  card: PaymentKind.CLIENT_CARD,
  kaspi_placeholder: PaymentKind.CLIENT_KASPI_PLACEHOLDER
} as const;

const submitProofSchema = z.object({
  orderId: z.string(),
  executorId: z.string().optional(),
  photoUri: z.string().min(3),
  photoBase64: z.string().min(4).max(14_000_000),
  fileName: z.string().max(120).optional(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  notes: z.string().max(500).optional(),
  checklist: z.array(z.string().min(1).max(120)).min(1).max(30)
});

const completeQualitySchema = z.object({
  score: z.number().int().min(0).max(100).default(92),
  notes: z.string().max(500).optional(),
  approved: z.boolean().default(true)
});

const markNotificationSchema = z.object({
  read: z.boolean().default(true)
});

const manualAssignSchema = z.object({
  executorId: z.string()
});

const createReviewSchema = z.object({
  orderId: z.string(),
  clientId: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional()
});

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  rating: true,
  distanceKm: true,
  activeOrders: true,
  completedOrders: true
} satisfies Prisma.UserSelect;

const publicOrderInclude = {
  client: { select: publicUserSelect },
  executor: { select: publicUserSelect },
  service: true,
  qualityChecks: true,
  payments: true
} satisfies Prisma.OrderInclude;

function publicUser(user: { id: string; name: string; email: string | null; phone: string | null; role: Role; rating: number; distanceKm: number; activeOrders: number; completedOrders: number }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    rating: user.rating,
    distanceKm: user.distanceKm,
    activeOrders: user.activeOrders,
    completedOrders: user.completedOrders
  };
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string | null) {
  if (!storedHash) return false;
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const actual = Buffer.from(hash, "hex");
  const expected = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + 1000 * 60 * 60 * 24 * appConfig.sessionTtlDays
  );
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt
    }
  });
  return { token, expiresAt };
}

async function getUserFromRequest(request: { headers: { authorization?: string } }) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }
  return session.user;
}

async function requireUser(request: { headers: { authorization?: string } }) {
  const user = await getUserFromRequest(request);
  if (!user) throw apiError("AUTH_REQUIRED", "Authentication is required", 401);
  return user;
}

function hasAnyRole(user: User, roles: readonly Role[]) {
  return roles.includes(user.role);
}

function requireAnyRole(user: User, roles: readonly Role[]) {
  if (!hasAnyRole(user, roles)) {
    throw apiError("ROLE_FORBIDDEN", "This role cannot perform the operation", 403, {
      role: user.role,
      allowedRoles: roles
    });
  }
}

function assertSelfOrRole(
  user: User,
  userId: string,
  roles: readonly Role[] = OPERATION_ROLES
) {
  if (user.id !== userId && !hasAnyRole(user, roles)) {
    throw apiError("RESOURCE_FORBIDDEN", "You cannot access this user's resource", 403);
  }
}

async function saveProofMedia(input: {
  orderId: string;
  photoUri: string;
  photoBase64: string;
  fileName?: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}) {
  const { buffer, mimeType } = decodeAndValidateProofImage(
    input.photoBase64,
    input.mimeType
  );
  await mkdir(proofStorageDir, { recursive: true });
  const extension = extensionForProofMimeType(mimeType);
  const fileName = `${input.orderId}-${Date.now()}-${randomBytes(6).toString("hex")}${extension}`;
  await writeFile(new URL(fileName, proofStorageDir), buffer);

  return {
    kind: "PHOTO_FILE",
    uri: `storage://proofs/${fileName}`,
    stored: true,
    sizeBytes: buffer.length
  };
}

function pseudoCoordinateOffset(address: string, salt: number) {
  let hash = salt;
  for (const char of address) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  }
  return (hash / 100000 - 0.5) * 0.08;
}

function geocodePlaceholder(address: string) {
  const normalized = address.trim();
  const lower = normalized.toLowerCase();
  const cityCenter = lower.includes("astana") || lower.includes("астана")
    ? { city: "Astana", lat: 51.1282, lng: 71.4304 }
    : { city: "Almaty", lat: 43.2389, lng: 76.8897 };
  const latitude = Number((cityCenter.lat + pseudoCoordinateOffset(normalized, 17)).toFixed(6));
  const longitude = Number((cityCenter.lng + pseudoCoordinateOffset(normalized, 29)).toFixed(6));
  const serviceZone = cityCenter.city === "Almaty" ? "ALMATY_CORE" : "ASTANA_CORE";

  return {
    provider: "placeholder",
    address: normalized,
    city: cityCenter.city,
    latitude,
    longitude,
    serviceZone,
    inServiceArea: true,
    confidence: 0.72,
    note: "Deterministic MVP geocode placeholder; replace with real provider after provider decision."
  };
}

async function applyOrderTransition(
  tx: Prisma.TransactionClient,
  input: {
    order: { id: string; status: OrderStatus; version: number };
    toStatus: OrderStatus;
    context: TransitionContext;
    actorId?: string | null;
    reason: string;
    metadata?: Prisma.InputJsonValue;
    data?: Prisma.OrderUncheckedUpdateManyInput;
  }
) {
  assertOrderTransition(input.order.status, input.toStatus, input.context);

  const update = await tx.order.updateMany({
    where: {
      id: input.order.id,
      status: input.order.status,
      version: input.order.version
    },
    data: {
      ...input.data,
      status: input.toStatus,
      version: { increment: 1 }
    }
  });

  if (update.count !== 1) {
    throw apiError(
      "ORDER_CONCURRENT_UPDATE",
      "Order changed while the operation was in progress",
      409,
      { orderId: input.order.id }
    );
  }

  await tx.orderStatusHistory.create({
    data: {
      orderId: input.order.id,
      fromStatus: input.order.status,
      toStatus: input.toStatus,
      actorId: input.actorId,
      reason: input.reason,
      metadata: input.metadata ?? {}
    }
  });
}

async function createNotification(input: {
  userId: string | null | undefined;
  type: string;
  title: string;
  body: string;
  metadata?: Prisma.InputJsonValue;
}) {
  if (!input.userId) return null;
  return prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata: input.metadata ?? {}
    }
  });
}

app.get("/health", async () => {
  return { ok: true, service: "ai-cleaning-api" };
});

app.get("/geo/geocode", async (request) => {
  const input = geocodeSchema.parse(request.query);
  return geocodePlaceholder(input.address);
});

app.get("/catalog/services", async () => {
  return prisma.serviceCatalog.findMany({ orderBy: { basePrice: "asc" } });
});

app.get("/notifications/:userId", async (request) => {
  const user = await requireUser(request);
  const { userId } = request.params as { userId: string };
  assertSelfOrRole(user, userId);
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 30
  });
});

app.post("/notifications/:id/read", async (request) => {
  const user = await requireUser(request);
  const { id } = request.params as { id: string };
  const input = markNotificationSchema.parse(request.body ?? {});
  const existing = await prisma.notification.findUnique({ where: { id } });
  if (!existing) {
    throw apiError("NOTIFICATION_NOT_FOUND", "Notification not found", 404);
  }
  assertSelfOrRole(user, existing.userId);
  const notification = await prisma.notification.update({
    where: { id },
    data: {
      status: input.read ? "READ" : "DELIVERED",
      readAt: input.read ? new Date() : null
    }
  });
  return { notification };
});

app.post("/auth/demo-login", async (request) => {
  if (!demoLoginEnabled()) {
    throw apiError("ROUTE_NOT_FOUND", "Route not found", 404);
  }
  const input = demoLoginSchema.parse(request.body);
  const user = await prisma.user.findFirst({ where: { role: input.role as Role } });
  if (user) {
    const session = await createSession(user.id);
    return { user: publicUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  const created = await prisma.user.create({
      data: {
        name: `Demo ${input.role.toLowerCase()}`,
        email: `${input.role.toLowerCase()}@ai-cleaning.local`,
        role: input.role as Role
      }
    });
  const session = await createSession(created.id);
  return { user: publicUser(created), token: session.token, expiresAt: session.expiresAt };
});

app.post("/auth/register", async (request) => {
  const input = registerSchema.parse(request.body);

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        ...(input.email ? [{ email: input.email }] : []),
        ...(input.phone ? [{ phone: input.phone }] : [])
      ]
    }
  });
  if (existing) {
    throw apiError("USER_ALREADY_EXISTS", "User already exists", 409);
  }

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: hashPassword(input.password),
      role: input.role as Role
    }
  });
  const session = await createSession(user.id);

  return { user: publicUser(user), token: session.token, expiresAt: session.expiresAt };
});

app.post("/auth/login", async (request) => {
  const input = loginSchema.parse(request.body);
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: input.identifier }, { phone: input.identifier }]
    }
  });

  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw apiError("AUTH_INVALID_CREDENTIALS", "Invalid credentials", 401);
  }

  const session = await createSession(user.id);
  return { user: publicUser(user), token: session.token, expiresAt: session.expiresAt };
});

app.get("/auth/me", async (request) => {
  const user = await requireUser(request);
  return { user: publicUser(user) };
});

app.post("/auth/logout", async (request) => {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  return { ok: true };
});

app.get("/orders", async (request) => {
  const user = await requireUser(request);
  const where = orderScopeForRole(user);
  return prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: publicOrderInclude
  });
});

app.get("/clients/:clientId/orders", async (request) => {
  const user = await requireUser(request);
  const { clientId } = request.params as { clientId: string };
  assertSelfOrRole(user, clientId);
  return prisma.order.findMany({
    where: { clientId },
    orderBy: { updatedAt: "desc" },
    take: 30,
    include: {
      service: true,
      executor: { select: publicUserSelect },
      payments: true,
      qualityChecks: true,
      reviews: true
    }
  });
});

app.post("/reviews", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const input = createReviewSchema.parse(request.body);
  assertSelfOrRole(user, input.clientId, []);
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (order.clientId !== input.clientId) {
    throw apiError("ORDER_FORBIDDEN", "Client does not own order", 403);
  }
  if (
    order.status !== OrderStatus.COMPLETED &&
    order.status !== OrderStatus.PAYMENT_RELEASED
  ) {
    throw apiError(
      "REVIEW_ORDER_NOT_COMPLETED",
      "A review can only be created for a completed order",
      409,
      { status: order.status }
    );
  }
  const existingReview = await prisma.review.findUnique({
    where: {
      orderId_clientId: {
        orderId: order.id,
        clientId: input.clientId
      }
    }
  });
  if (existingReview) {
    throw apiError("REVIEW_ALREADY_EXISTS", "A review already exists for this order", 409);
  }

  const review = await prisma.review.create({
    data: {
      orderId: order.id,
      clientId: input.clientId,
      executorId: order.executorId,
      rating: input.rating,
      comment: input.comment
    }
  });

  if (order.executorId) {
    const aggregate = await prisma.review.aggregate({
      where: { executorId: order.executorId },
      _avg: { rating: true },
      _count: true
    });
    await prisma.user.update({
      where: { id: order.executorId },
      data: { rating: Number((aggregate._avg.rating ?? 5).toFixed(2)) }
    });
  }

  await prisma.auditEvent.create({
    data: {
      actorId: input.clientId,
      action: "CLIENT_REVIEW_CREATED",
      target: `order:${order.id}`,
      metadata: { reviewId: review.id, rating: review.rating }
    }
  });

  await createNotification({
    userId: order.executorId,
    type: "CLIENT_REVIEW_CREATED",
    title: "Получен отзыв клиента",
    body: `Клиент оценил заказ ${order.id} на ${review.rating}/5.`,
    metadata: { orderId: order.id, reviewId: review.id, rating: review.rating }
  });

  return { review };
});

app.get("/operations/dashboard", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  const [orders, users, aiEvents, pendingQuality, disputes, unassigned, activeOrders, recentOrders, recommendedExecutor] = await Promise.all([
    prisma.order.count(),
    prisma.user.count(),
    prisma.aiEvent.count(),
    prisma.order.count({ where: { status: OrderStatus.QUALITY_CHECK } }),
    prisma.order.count({ where: { status: OrderStatus.DISPUTE } }),
    prisma.order.count({ where: { executorId: null } }),
    prisma.order.count({ where: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, OrderStatus.QUALITY_CHECK] } } }),
    prisma.order.findMany({
      orderBy: { updatedAt: "desc" },
      take: 6,
      include: publicOrderInclude
    }),
    prisma.user.findFirst({ where: { role: Role.EXECUTOR }, orderBy: [{ activeOrders: "asc" }, { rating: "desc" }] })
  ]);
  const revenue = await prisma.order.aggregate({ _sum: { priceTotal: true } });

  return {
    orders,
    users,
    aiEvents,
    revenue: revenue._sum.priceTotal ?? 0,
    pendingQuality,
    disputes,
    unassigned,
    activeOrders,
    recommendedExecutorId: recommendedExecutor?.id ?? null,
    recentOrders
  };
});

app.get("/operations/orders", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  return prisma.order.findMany({
    orderBy: { updatedAt: "desc" },
    take: 30,
    include: publicOrderInclude
  });
});

app.post("/operations/orders/:id/manual-assign", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  const { id } = request.params as { id: string };
  const input = manualAssignSchema.parse(request.body);
  const executor = await prisma.user.findUnique({ where: { id: input.executorId } });
  if (!executor || executor.role !== Role.EXECUTOR) {
    throw apiError("EXECUTOR_NOT_FOUND", "Executor not found", 404);
  }
  const existingOrder = await prisma.order.findUnique({ where: { id } });
  if (!existingOrder) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (
    existingOrder.status !== OrderStatus.CONFIRMED &&
    existingOrder.status !== OrderStatus.ASSIGNED
  ) {
    throw apiError(
      "ORDER_NOT_ASSIGNABLE",
      "Only a confirmed or already assigned order can be manually assigned",
      409,
      { status: existingOrder.status }
    );
  }

  await prisma.$transaction(async (tx) => {
    if (existingOrder.status === OrderStatus.CONFIRMED) {
      await applyOrderTransition(tx, {
        order: existingOrder,
        toStatus: OrderStatus.ASSIGNED,
        context: "MANUAL_ASSIGNMENT",
        actorId: user.id,
        reason: "Operator manually assigned an executor",
        metadata: { executorId: executor.id },
        data: { executorId: executor.id }
      });
    } else {
      const changed = await tx.order.updateMany({
        where: { id, version: existingOrder.version, status: OrderStatus.ASSIGNED },
        data: { executorId: executor.id, version: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw apiError(
          "ORDER_CONCURRENT_UPDATE",
          "Order changed while the assignment was in progress",
          409
        );
      }
    }

    if (existingOrder.executorId && existingOrder.executorId !== executor.id) {
      await tx.user.update({
        where: { id: existingOrder.executorId },
        data: { activeOrders: { decrement: 1 } }
      });
    }
    if (existingOrder.executorId !== executor.id) {
      await tx.user.update({
        where: { id: executor.id },
        data: { activeOrders: { increment: 1 } }
      });
    }

    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "ORDER_MANUALLY_ASSIGNED",
        target: `order:${id}`,
        metadata: {
          executorId: executor.id,
          previousExecutorId: existingOrder.executorId
        }
      }
    });
  });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: {
      service: true,
      client: { select: publicUserSelect },
      executor: { select: publicUserSelect }
    }
  });

  await Promise.all([
    createNotification({
      userId: order.executorId,
      type: "ORDER_ASSIGNED",
      title: "Заказ назначен вручную",
      body: `Оператор назначил вам заказ ${order.id}.`,
      metadata: { orderId: order.id, executorId: executor.id }
    }),
    createNotification({
      userId: order.clientId,
      type: "EXECUTOR_ASSIGNED",
      title: "Исполнитель назначен",
      body: `Оператор назначил исполнителя ${executor.name} на ваш заказ.`,
      metadata: { orderId: order.id, executorId: executor.id }
    })
  ]);

  return { order };
});

app.post("/orders", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const input = createOrderSchema.parse(request.body);
  assertSelfOrRole(user, input.clientId, []);
  const service = await prisma.serviceCatalog.findUnique({
    where: { id: input.serviceId }
  });
  if (!service || !service.mvp) {
    throw apiError(
      "SERVICE_NOT_AVAILABLE",
      "The selected service is not available in MVP",
      400,
      { serviceId: input.serviceId }
    );
  }
  const price = estimateOrderPrice(input);

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        clientId: input.clientId,
        serviceId: input.serviceId,
        address: input.address,
        areaSqm: input.areaSqm,
        rooms: input.rooms,
        hasPets: input.hasPets,
        urgent: input.urgent,
        latitude: input.latitude,
        longitude: input.longitude,
        serviceZone: input.serviceZone,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
        priceTotal: price.total,
        complexityScore: price.complexityScore,
        status: OrderStatus.PRICED,
        aiEvents: {
          create: {
            module: "AI_PRICING_RULES",
            input,
            output: price,
            explanation: price.explanation
          }
        },
        statusHistory: {
          create: {
            fromStatus: OrderStatus.CREATED,
            toStatus: OrderStatus.PRICED,
            actorId: user.id,
            reason: "Price calculated during order creation",
            metadata: { pricingModule: "AI_PRICING_RULES" }
          }
        }
      },
      include: { service: true, aiEvents: true }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "ORDER_CREATED_AND_PRICED",
        target: `order:${created.id}`,
        metadata: { status: created.status, priceTotal: created.priceTotal }
      }
    });
    return created;
  });

  await createNotification({
    userId: order.clientId,
    type: "ORDER_PRICED",
    title: "Расчёт заказа готов",
    body: `Стоимость заказа «${order.service.title}» — ${order.priceTotal} ${appConfig.currency}.`,
    metadata: { orderId: order.id, status: order.status }
  });

  return { order };
});

app.post("/orders/:id/assign", async (request) => {
  const user = await requireUser(request);
  const { id } = request.params as { id: string };
  const existingOrder = await prisma.order.findUnique({ where: { id } });
  if (!existingOrder) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  const canAssign =
    (user.role === Role.CLIENT && existingOrder.clientId === user.id) ||
    hasAnyRole(user, OPERATION_ROLES);
  if (!canAssign) {
    throw apiError("ORDER_ASSIGN_FORBIDDEN", "You cannot assign this order", 403);
  }
  assertOrderTransition(existingOrder.status, OrderStatus.ASSIGNED, "MATCHING");
  const executors = await prisma.user.findMany({ where: { role: Role.EXECUTOR } });
  const ranked = executors
    .map((executor) => ({
      executor,
      score: scoreExecutor({
        id: executor.id,
        name: executor.name,
        distanceKm: executor.distanceKm,
        rating: executor.rating,
        activeOrders: executor.activeOrders,
        completedOrders: executor.completedOrders
      })
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    throw apiError("EXECUTOR_NOT_AVAILABLE", "No executor candidates found", 404);
  }

  await prisma.$transaction(async (tx) => {
    await applyOrderTransition(tx, {
      order: existingOrder,
      toStatus: OrderStatus.ASSIGNED,
      context: "MATCHING",
      actorId: user.id,
      reason: "Executor selected by transparent matching rules",
      metadata: { executorId: best.executor.id, score: best.score },
      data: { executorId: best.executor.id }
    });
    await tx.aiEvent.create({
      data: {
        orderId: id,
        module: "AI_MATCHING_RULES",
        input: { orderId: id },
        output: {
          executorId: best.executor.id,
          score: best.score,
          ranked: ranked.map((item) => ({ id: item.executor.id, score: item.score }))
        },
        explanation: [
          "Distance, rating, active load, and completed orders were scored with transparent rules."
        ]
      }
    });
    await tx.user.update({
      where: { id: best.executor.id },
      data: { activeOrders: { increment: 1 } }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "ORDER_AUTOMATICALLY_ASSIGNED",
        target: `order:${id}`,
        metadata: { executorId: best.executor.id, score: best.score }
      }
    });
  });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: {
      executor: { select: publicUserSelect },
      aiEvents: {
        where: { module: "AI_MATCHING_RULES" },
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  await Promise.all([
    createNotification({
      userId: order.executorId,
      type: "ORDER_ASSIGNED",
      title: "Новый назначенный заказ",
      body: `Вам назначен заказ ${order.id}.`,
      metadata: { orderId: order.id, score: best.score }
    }),
    createNotification({
      userId: order.clientId,
      type: "EXECUTOR_ASSIGNED",
      title: "Исполнитель назначен",
      body: `На ваш заказ назначен исполнитель ${order.executor?.name ?? "Исполнитель"}.`,
      metadata: { orderId: order.id, executorId: order.executorId }
    })
  ]);

  return { order };
});

app.post("/orders/:id/status", async (request) => {
  const user = await requireUser(request);
  const { id } = request.params as { id: string };
  const body = z.object({ status: z.nativeEnum(OrderStatus) }).parse(request.body);
  const existingOrder = await prisma.order.findUnique({ where: { id } });
  if (!existingOrder) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (
    body.status !== OrderStatus.ACCEPTED &&
    body.status !== OrderStatus.IN_PROGRESS
  ) {
    throw apiError(
      "ORDER_STATUS_ENDPOINT_RESTRICTED",
      "This endpoint only supports executor acceptance and start transitions",
      400,
      { requestedStatus: body.status }
    );
  }
  assertExecutorProgress(user, existingOrder, body.status);

  await prisma.$transaction(async (tx) => {
    await applyOrderTransition(tx, {
      order: existingOrder,
      toStatus: body.status,
      context: "EXECUTOR_PROGRESS",
      actorId: user.id,
      reason:
        body.status === OrderStatus.ACCEPTED
          ? "Assigned executor accepted the order"
          : "Assigned executor started the work"
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action:
          body.status === OrderStatus.ACCEPTED
            ? "EXECUTOR_ACCEPTED_ORDER"
            : "CLEANING_STARTED",
        target: `order:${id}`,
        metadata: { fromStatus: existingOrder.status, toStatus: body.status }
      }
    });
  });
  const order = await prisma.order.findUniqueOrThrow({ where: { id } });
  await Promise.all([
    createNotification({
      userId: order.clientId,
      type: "ORDER_STATUS",
      title: "Статус заказа изменён",
      body: `Новый статус заказа ${order.id}: ${order.status}.`,
      metadata: { orderId: order.id, status: order.status }
    }),
    createNotification({
      userId: order.executorId,
      type: "ORDER_STATUS",
      title: "Статус задачи изменён",
      body: `Новый статус задачи ${order.id}: ${order.status}.`,
      metadata: { orderId: order.id, status: order.status }
    })
  ]);
  return { order };
});

app.post("/payments/intent", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const input = createPaymentSchema.parse(request.body);
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (order.clientId !== user.id) {
    throw apiError("ORDER_FORBIDDEN", "Client does not own order", 403);
  }
  if (order.status !== OrderStatus.PRICED) {
    throw apiError(
      "PAYMENT_ORDER_NOT_PRICED",
      "Payment intent can only be created for a priced order",
      409,
      { status: order.status }
    );
  }

  const headerValue = request.headers["idempotency-key"];
  const idempotencyKey =
    typeof headerValue === "string" && headerValue.trim()
      ? headerValue.trim()
      : undefined;
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 120)) {
    throw apiError(
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key must contain between 8 and 120 characters",
      400
    );
  }
  if (idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: { idempotencyKey }
    });
    if (existingByKey) {
      if (existingByKey.orderId !== order.id) {
        throw apiError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used for another order",
          409
        );
      }
      return { payment: existingByKey };
    }
  }

  const existingIntent = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      kind: {
        in: [
          PaymentKind.CLIENT_CASH,
          PaymentKind.CLIENT_CARD,
          PaymentKind.CLIENT_KASPI_PLACEHOLDER
        ]
      },
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (existingIntent) return { payment: existingIntent };

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      amount: order.priceTotal,
      status: PaymentStatus.PENDING,
      kind: paymentKindByMethod[input.method],
      idempotencyKey
    }
  });

  await prisma.auditEvent.create({
    data: {
      actorId: order.clientId,
      action: "PAYMENT_INTENT_CREATED",
      target: `order:${order.id}`,
      metadata: { paymentId: payment.id, amount: payment.amount, method: input.method }
    }
  });

  await createNotification({
    userId: order.clientId,
    type: "PAYMENT_INTENT",
    title: "Создано удержание оплаты",
    body: `Ожидается подтверждение оплаты ${payment.amount} ${appConfig.currency}.`,
    metadata: { orderId: order.id, paymentId: payment.id, status: payment.status }
  });

  return { payment };
});

app.post("/payments/:id/confirm", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const { id } = request.params as { id: string };
  const existingPayment = await prisma.payment.findUnique({ where: { id }, include: { order: true } });
  if (!existingPayment) throw apiError("PAYMENT_NOT_FOUND", "Payment not found", 404);
  if (existingPayment.order.clientId !== user.id) {
    throw apiError("PAYMENT_FORBIDDEN", "Client does not own this payment", 403);
  }
  if (
    existingPayment.status === PaymentStatus.PAID &&
    existingPayment.order.status === OrderStatus.CONFIRMED
  ) {
    return { payment: existingPayment, order: existingPayment.order };
  }
  if (existingPayment.status !== PaymentStatus.PENDING) {
    throw apiError(
      "PAYMENT_NOT_PENDING",
      "Only a pending payment can be confirmed",
      409,
      { status: existingPayment.status }
    );
  }

  await prisma.$transaction(async (tx) => {
    const paymentUpdate = await tx.payment.updateMany({
      where: { id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.PAID }
    });
    if (paymentUpdate.count !== 1) {
      throw apiError(
        "PAYMENT_CONCURRENT_UPDATE",
        "Payment changed while confirmation was in progress",
        409
      );
    }
    await applyOrderTransition(tx, {
      order: existingPayment.order,
      toStatus: OrderStatus.CONFIRMED,
      context: "PAYMENT_CONFIRMATION",
      actorId: user.id,
      reason: "Client payment was confirmed",
      metadata: { paymentId: id, amount: existingPayment.amount }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "PAYMENT_CONFIRMED",
        target: `payment:${id}`,
        metadata: {
          orderId: existingPayment.orderId,
          amount: existingPayment.amount
        }
      }
    });
  });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id } });
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: payment.orderId },
    include: { service: true, payments: true }
  });

  await createNotification({
    userId: order.clientId,
    type: "PAYMENT_CONFIRMED",
    title: "Оплата подтверждена",
    body: `Оплата заказа ${order.id} подтверждена.`,
    metadata: { orderId: order.id, paymentId: payment.id, status: payment.status }
  });

  return { payment, order };
});

app.post("/payments/release/:orderId", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  const { orderId } = request.params as { orderId: string };
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (!order.executorId) {
    throw apiError("ORDER_EXECUTOR_MISSING", "Order has no executor", 409);
  }
  const existingPayout = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      kind: PaymentKind.EXECUTOR_PAYOUT,
      status: PaymentStatus.RELEASED
    }
  });
  if (existingPayout && order.status === OrderStatus.PAYMENT_RELEASED) {
    return { payout: existingPayout, order };
  }
  assertOrderTransition(order.status, OrderStatus.PAYMENT_RELEASED, "PAYOUT_RELEASE");

  const payoutAmount = Math.round(order.priceTotal * appConfig.payoutRatio);
  const payout = await prisma.$transaction(async (tx) => {
    const createdPayout = await tx.payment.create({
      data: {
        orderId: order.id,
        amount: payoutAmount,
        status: PaymentStatus.RELEASED,
        kind: PaymentKind.EXECUTOR_PAYOUT
      }
    });
    await applyOrderTransition(tx, {
      order,
      toStatus: OrderStatus.PAYMENT_RELEASED,
      context: "PAYOUT_RELEASE",
      actorId: user.id,
      reason: "Operator released executor payout",
      metadata: { payoutId: createdPayout.id, amount: createdPayout.amount }
    });
    await tx.user.update({
      where: { id: order.executorId! },
      data: {
        completedOrders: { increment: 1 },
        activeOrders: { decrement: 1 }
      }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "PAYOUT_RELEASED",
        target: `order:${order.id}`,
        metadata: { payoutId: createdPayout.id, amount: createdPayout.amount }
      }
    });
    return createdPayout;
  });
  const updatedOrder = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { service: true, payments: true }
  });

  await createNotification({
    userId: order.executorId,
    type: "PAYOUT_RELEASED",
    title: "Выплата проведена",
    body: `Проведена выплата ${payout.amount} ${appConfig.currency}.`,
    metadata: { orderId: order.id, payoutId: payout.id }
  });

  return { payout, order: updatedOrder };
});

app.post("/quality/proof", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.EXECUTOR]);
  const input = submitProofSchema.parse(request.body);
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (order.executorId !== user.id || (input.executorId && input.executorId !== user.id)) {
    throw apiError(
      "ORDER_EXECUTOR_REQUIRED",
      "Only the assigned executor can submit proof",
      403
    );
  }
  const transitionContext =
    order.status === OrderStatus.DISPUTE ? "REWORK_SUBMISSION" : "PROOF_SUBMISSION";
  assertOrderTransition(order.status, OrderStatus.QUALITY_CHECK, transitionContext);

  const storedMedia = await saveProofMedia({
    orderId: order.id,
    photoUri: input.photoUri,
    photoBase64: input.photoBase64,
    fileName: input.fileName,
    mimeType: input.mimeType
  });

  const checklistScore = Math.min(100, 70 + input.checklist.length * 6 + 14);
  const result = await prisma.$transaction(async (tx) => {
    const proof = await tx.proofAsset.create({
      data: {
        orderId: order.id,
        kind: storedMedia.kind,
        uri: storedMedia.uri,
        notes: input.notes
      }
    });
    const qualityCheck = await tx.qualityCheck.create({
      data: {
        orderId: order.id,
        status: QualityCheckStatus.PENDING_REVIEW,
        score: checklistScore,
        notes: input.notes ?? "Proof submitted by performer"
      }
    });
    await applyOrderTransition(tx, {
      order,
      toStatus: OrderStatus.QUALITY_CHECK,
      context: transitionContext,
      actorId: user.id,
      reason:
        transitionContext === "REWORK_SUBMISSION"
          ? "Executor submitted rework proof"
          : "Executor submitted completion proof",
      metadata: {
        proofId: proof.id,
        qualityCheckId: qualityCheck.id,
        checklist: input.checklist
      }
    });
    if (order.status === OrderStatus.DISPUTE) {
      await tx.dispute.updateMany({
        where: { orderId: order.id, status: { not: DisputeStatus.RESOLVED } },
        data: { status: DisputeStatus.REWORK_REQUESTED }
      });
    }
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: order.status === OrderStatus.DISPUTE ? "REWORK_PROOF_SUBMITTED" : "PROOF_SUBMITTED",
        target: `order:${order.id}`,
        metadata: {
          proofId: proof.id,
          qualityCheckId: qualityCheck.id,
          checklist: input.checklist,
          media: { uri: proof.uri, kind: proof.kind, sizeBytes: storedMedia.sizeBytes }
        }
      }
    });
    return { proof, qualityCheck };
  });
  const { proof, qualityCheck } = result;
  const updatedOrder = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { service: true, qualityChecks: true, proofAssets: true }
  });

  await Promise.all([
    createNotification({
      userId: order.clientId,
      type: "QUALITY_CHECK",
      title: "Заказ передан на контроль качества",
      body: `По заказу ${order.id} отправлен фотоотчёт.`,
      metadata: { orderId: order.id, qualityCheckId: qualityCheck.id, proofId: proof.id }
    }),
    createNotification({
      userId: order.executorId,
      type: "PROOF_SUBMITTED",
      title: "Фотоотчёт отправлен",
      body: `Ваш фотоотчёт по заказу ${order.id} сохранён.`,
      metadata: { orderId: order.id, qualityCheckId: qualityCheck.id, proofId: proof.id }
    })
  ]);

  return { proof, qualityCheck, order: updatedOrder };
});

app.post("/quality/:orderId/complete", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, QUALITY_ROLES);
  const { orderId } = request.params as { orderId: string };
  const input = completeQualitySchema.parse(request.body);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  const nextStatus = input.approved ? OrderStatus.COMPLETED : OrderStatus.DISPUTE;
  assertOrderTransition(order.status, nextStatus, "QUALITY_DECISION");

  const qualityCheck = await prisma.$transaction(async (tx) => {
    const createdCheck = await tx.qualityCheck.create({
      data: {
        orderId: order.id,
        status: input.approved
          ? QualityCheckStatus.APPROVED
          : QualityCheckStatus.REWORK_REQUIRED,
        score: input.score,
        notes: input.notes
      }
    });
    await applyOrderTransition(tx, {
      order,
      toStatus: nextStatus,
      context: "QUALITY_DECISION",
      actorId: user.id,
      reason: input.approved
        ? "Quality manager approved the order"
        : "Quality manager requested rework",
      metadata: { qualityCheckId: createdCheck.id, score: input.score }
    });

    if (input.approved) {
      await tx.dispute.updateMany({
        where: { orderId: order.id, status: { not: DisputeStatus.RESOLVED } },
        data: {
          status: DisputeStatus.RESOLVED,
          resolution: input.notes ?? "Quality approved after review",
          resolvedById: user.id,
          resolvedAt: new Date()
        }
      });
    } else {
      await tx.dispute.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          status: DisputeStatus.OPEN,
          reason: input.notes ?? "Quality rework required",
          openedById: user.id
        },
        update: {
          status: DisputeStatus.OPEN,
          reason: input.notes ?? "Quality rework required",
          resolution: null,
          openedById: user.id,
          resolvedById: null,
          resolvedAt: null
        }
      });
    }

    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: input.approved ? "QUALITY_APPROVED" : "QUALITY_REWORK_REQUIRED",
        target: `order:${order.id}`,
        metadata: { qualityCheckId: createdCheck.id, score: input.score }
      }
    });
    return createdCheck;
  });
  const updatedOrder = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { service: true, qualityChecks: true, proofAssets: true }
  });

  await Promise.all([
    createNotification({
      userId: order.clientId,
      type: input.approved ? "ORDER_COMPLETED" : "DISPUTE",
      title: input.approved ? "Заказ завершён" : "Открыта проблема качества",
      body: input.approved ? `Заказ ${order.id} прошёл контроль качества.` : `Заказ ${order.id} требует повторной работы.`,
      metadata: { orderId: order.id, qualityCheckId: qualityCheck.id, score: input.score }
    }),
    createNotification({
      userId: order.executorId,
      type: input.approved ? "QUALITY_APPROVED" : "REWORK_REQUIRED",
      title: input.approved ? "Качество подтверждено" : "Требуется доработка",
      body: input.approved ? `Заказ ${order.id} подтверждён.` : `Заказ ${order.id} требует доработки.`,
      metadata: { orderId: order.id, qualityCheckId: qualityCheck.id, score: input.score }
    })
  ]);

  return { qualityCheck, order: updatedOrder };
});

app.get("/performer/tasks/:executorId", async (request) => {
  const user = await requireUser(request);
  const { executorId } = request.params as { executorId: string };
  assertSelfOrRole(user, executorId);
  if (user.id === executorId && user.role !== Role.EXECUTOR) {
    throw apiError(
      "EXECUTOR_ROLE_REQUIRED",
      "Only an executor can access performer tasks",
      403
    );
  }
  return prisma.order.findMany({
    where: { executorId },
    orderBy: { updatedAt: "desc" },
    include: { service: true, client: { select: publicUserSelect } }
  });
});

app.get("/analytics/summary", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, ANALYTICS_ROLES);
  const [orders, users, aiEvents] = await Promise.all([
    prisma.order.count(),
    prisma.user.count(),
    prisma.aiEvent.count()
  ]);
  const revenue = await prisma.order.aggregate({ _sum: { priceTotal: true } });
  return {
    orders,
    users,
    aiEvents,
    revenue: revenue._sum.priceTotal ?? 0
  };
});

const port = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== "test") {
  app.listen({ port, host: "0.0.0.0" }).catch(async (error) => {
    app.log.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
}
