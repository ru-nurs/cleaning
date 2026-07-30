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
import {
  analyzeQualityVision,
  analyzeReview,
  assessOrderRisk,
  forecastDemand,
  getAiStatus
} from "./ai.js";
import { decodeAndValidateProofImage, decodeAndValidateProofMedia, extensionForProofMimeType } from "./media.js";
import { isStrongPassword, PASSWORD_MAX_LENGTH } from "./passwordPolicy.js";
import { getPushStatus, sendPush } from "./push.js";

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
  password: z.string().max(PASSWORD_MAX_LENGTH).refine(isStrongPassword, {
    message: "Password must be at least 12 characters and contain a Latin letter and a digit"
  }),
  role: authRoleSchema.default("CLIENT")
}).refine((value) => value.email || value.phone, {
  message: "Email or phone is required"
});

const loginSchema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(6).max(PASSWORD_MAX_LENGTH)
});

const nullableEmailSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().email().max(254).transform((value) => value.toLowerCase()).nullable()
);

const nullablePhoneSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().min(6).max(24).nullable()
);

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: nullableEmailSchema,
  phone: nullablePhoneSchema
}).refine((value) => value.email || value.phone, {
  message: "Email or phone is required"
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().max(PASSWORD_MAX_LENGTH).refine(isStrongPassword, {
    message: "Password must be at least 12 characters and contain a Latin letter and a digit"
  })
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
  beforePhotoUri: z.string().min(3).optional(),
  beforePhotoBase64: z.string().min(4).max(14_000_000).optional(),
  beforeFileName: z.string().max(120).optional(),
  beforeMimeType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4"]).optional(),
  beforeAnalysisFramesBase64: z.array(z.string().min(4).max(2_000_000)).max(6).default([]),
  photoUri: z.string().min(3),
  photoBase64: z.string().min(4).max(14_000_000),
  fileName: z.string().max(120).optional(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4"]),
  analysisFramesBase64: z.array(z.string().min(4).max(2_000_000)).max(6).default([]),
  notes: z.string().max(500).optional(),
  checklist: z.array(z.string().min(1).max(120)).min(1).max(30)
}).superRefine((value, context) => {
  if (value.mimeType === "video/mp4" && value.analysisFramesBase64.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["analysisFramesBase64"],
      message: "At least one representative frame is required for video analysis"
    });
  }
  if (value.beforePhotoBase64 && !value.beforeMimeType) {
    context.addIssue({
      code: "custom",
      path: ["beforeMimeType"],
      message: "beforeMimeType is required with beforePhotoBase64"
    });
  }
  if (
    value.beforeMimeType === "video/mp4" &&
    value.beforePhotoBase64 &&
    value.beforeAnalysisFramesBase64.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["beforeAnalysisFramesBase64"],
      message: "At least one representative frame is required for before video analysis"
    });
  }
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

const executorAvailabilitySchema = z.object({
  acceptingJobs: z.boolean(),
  serviceZones: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
  shiftStartsAt: z.string().datetime().nullable().optional(),
  shiftEndsAt: z.string().datetime().nullable().optional()
}).superRefine((value, context) => {
  if (
    value.shiftStartsAt &&
    value.shiftEndsAt &&
    new Date(value.shiftStartsAt) >= new Date(value.shiftEndsAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["shiftEndsAt"],
      message: "shiftEndsAt must be after shiftStartsAt"
    });
  }
});

const manageExecutorSchema = z.object({
  verified: z.boolean().optional(),
  active: z.boolean().optional(),
  acceptingJobs: z.boolean().optional(),
  serviceZones: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
  shiftStartsAt: z.string().datetime().nullable().optional(),
  shiftEndsAt: z.string().datetime().nullable().optional()
});

const pushDeviceSchema = z.object({
  token: z.string().trim().min(32).max(4096),
  platform: z.enum(["ANDROID"]).default("ANDROID")
});

const createReviewSchema = z.object({
  orderId: z.string(),
  clientId: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional()
});

const forecastRequestSchema = z.object({
  horizonDays: z.number().int().min(1).max(31).default(7)
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
  completedOrders: true,
  executorProfile: {
    select: {
      verified: true,
      active: true,
      acceptingJobs: true,
      online: true,
      serviceZones: true,
      shiftStartsAt: true,
      shiftEndsAt: true,
      lastSeenAt: true
    }
  }
} satisfies Prisma.UserSelect;

const publicOrderInclude = {
  client: { select: publicUserSelect },
  executor: { select: publicUserSelect },
  service: true,
  qualityChecks: true,
  payments: true,
  aiEvents: {
    where: { module: { in: ["QUALITY_VISION", "ORDER_RISK"] } },
    orderBy: { createdAt: "desc" },
    take: 4
  }
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

function bearerTokenFromRequest(request: { headers: { authorization?: string } }) {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
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
  const token = bearerTokenFromRequest(request);
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
  stage: "BEFORE" | "AFTER";
  photoUri: string;
  photoBase64: string;
  fileName?: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
}) {
  const { buffer, mimeType } = decodeAndValidateProofMedia(
    input.photoBase64,
    input.mimeType
  );
  await mkdir(proofStorageDir, { recursive: true });
  const extension = extensionForProofMimeType(mimeType);
  const fileName = `${input.orderId}-${Date.now()}-${randomBytes(6).toString("hex")}${extension}`;
  await writeFile(new URL(fileName, proofStorageDir), buffer);

  return {
    kind: `${input.stage}_${mimeType === "video/mp4" ? "VIDEO" : "PHOTO"}`,
    uri: `storage://proofs/${fileName}`,
    stored: true,
    sizeBytes: buffer.length,
    mimeType
  };
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata: input.metadata ?? {}
    }
  });
  void (async () => {
    try {
      const devices = await prisma.pushDevice.findMany({
        where: { userId: input.userId!, enabled: true },
        select: { token: true }
      });
      const result = await sendPush({
        tokens: devices.map((device) => device.token),
        title: input.title,
        body: input.body,
        data: {
          type: input.type,
          notificationId: notification.id,
          ...(typeof input.metadata === "object" && input.metadata !== null
            ? Object.fromEntries(
                Object.entries(input.metadata)
                  .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
                  .map(([key, value]) => [key, String(value)])
              )
            : {})
        }
      });
      if (result.invalidTokens.length > 0) {
        await prisma.pushDevice.updateMany({
          where: { token: { in: result.invalidTokens } },
          data: { enabled: false }
        });
      }
      if (result.warning && result.warning !== "FCM_NOT_CONFIGURED") {
        app.log.warn({ warning: result.warning, userId: input.userId }, "push delivery warning");
      }
    } catch (error) {
      app.log.warn({ error, userId: input.userId }, "push delivery failed");
    }
  })();
  return notification;
}

type AssignmentOrder = {
  id: string;
  status: OrderStatus;
  version: number;
  clientId: string;
  serviceZone: string | null;
  scheduledAt: Date | null;
};

const EXECUTOR_RECENTLY_ONLINE_MS = 5 * 60 * 1000;

async function rankedEligibleExecutors(
  tx: Prisma.TransactionClient,
  order: Pick<AssignmentOrder, "serviceZone" | "scheduledAt">
) {
  const executors = await tx.user.findMany({
    where: {
      role: Role.EXECUTOR,
      executorProfile: {
        is: {
          verified: true,
          active: true,
          acceptingJobs: true
        }
      }
    },
    include: { executorProfile: true }
  });
  const assignmentTime = order.scheduledAt ?? new Date();
  const recentCutoff = Date.now() - EXECUTOR_RECENTLY_ONLINE_MS;

  return executors
    .filter((executor) => {
      const profile = executor.executorProfile;
      if (!profile) return false;
      if (
        order.serviceZone &&
        profile.serviceZones.length > 0 &&
        !profile.serviceZones.includes(order.serviceZone)
      ) {
        return false;
      }
      if (profile.shiftStartsAt && assignmentTime < profile.shiftStartsAt) return false;
      if (profile.shiftEndsAt && assignmentTime > profile.shiftEndsAt) return false;
      return true;
    })
    .map((executor) => {
      const recentlyOnline =
        executor.executorProfile?.lastSeenAt &&
        executor.executorProfile.lastSeenAt.getTime() >= recentCutoff;
      const availabilityBoost = executor.executorProfile?.online && recentlyOnline ? 8 : 0;
      return {
        executor,
        score:
          scoreExecutor({
            id: executor.id,
            name: executor.name,
            distanceKm: executor.distanceKm,
            rating: executor.rating,
            activeOrders: executor.activeOrders,
            completedOrders: executor.completedOrders
          }) + availabilityBoost,
        recentlyOnline: Boolean(recentlyOnline)
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function assignConfirmedOrderInTransaction(
  tx: Prisma.TransactionClient,
  order: AssignmentOrder,
  actorId: string | null,
  trigger: string
) {
  const ranked = await rankedEligibleExecutors(tx, order);
  const best = ranked[0];
  if (!best) {
    await tx.auditEvent.create({
      data: {
        actorId,
        action: "ORDER_ASSIGNMENT_PENDING",
        target: `order:${order.id}`,
        metadata: {
          trigger,
          reason: "NO_ELIGIBLE_EXECUTOR",
          serviceZone: order.serviceZone
        }
      }
    });
    return null;
  }

  await applyOrderTransition(tx, {
    order,
    toStatus: OrderStatus.ASSIGNED,
    context: "MATCHING",
    actorId,
    reason: `Executor selected by eligibility and matching rules (${trigger})`,
    metadata: {
      executorId: best.executor.id,
      score: best.score,
      recentlyOnline: best.recentlyOnline
    },
    data: { executorId: best.executor.id }
  });
  await tx.aiEvent.create({
    data: {
      orderId: order.id,
      module: "AI_MATCHING_RULES",
      input: {
        orderId: order.id,
        trigger,
        serviceZone: order.serviceZone,
        scheduledAt: order.scheduledAt
      },
      output: {
        executorId: best.executor.id,
        score: best.score,
        eligibility: {
          verified: true,
          active: true,
          acceptingJobs: true,
          recentlyOnline: best.recentlyOnline
        },
        ranked: ranked.map((item) => ({
          id: item.executor.id,
          score: item.score,
          recentlyOnline: item.recentlyOnline
        }))
      },
      explanation: [
        "Only verified, active executors accepting jobs inside their shift and service zone were considered.",
        "Distance, rating, current load, completed orders, and recent heartbeat were scored."
      ]
    }
  });
  await tx.user.update({
    where: { id: best.executor.id },
    data: { activeOrders: { increment: 1 } }
  });
  await tx.auditEvent.create({
    data: {
      actorId,
      action: "ORDER_AUTOMATICALLY_ASSIGNED",
      target: `order:${order.id}`,
      metadata: {
        trigger,
        executorId: best.executor.id,
        score: best.score
      }
    }
  });
  return {
    executorId: best.executor.id,
    executorName: best.executor.name,
    score: best.score
  };
}

async function confirmPlaceholderAndAssign(orderId: string, actorId: string) {
  const transactionResult = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);

    if (
      current.status !== OrderStatus.PRICED &&
      current.status !== OrderStatus.CONFIRMED
    ) {
      return { assignment: null, alreadyProcessed: true };
    }

    let confirmed: AssignmentOrder = current;
    if (current.status === OrderStatus.PRICED) {
      const existingPayment = await tx.payment.findFirst({
        where: {
          orderId,
          kind: PaymentKind.CLIENT_KASPI_PLACEHOLDER,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] }
        },
        orderBy: { createdAt: "desc" }
      });
      if (existingPayment) {
        if (existingPayment.status !== PaymentStatus.PAID) {
          await tx.payment.update({
            where: { id: existingPayment.id },
            data: { status: PaymentStatus.PAID }
          });
        }
      } else {
        await tx.payment.create({
          data: {
            orderId,
            amount: current.priceTotal,
            status: PaymentStatus.PAID,
            kind: PaymentKind.CLIENT_KASPI_PLACEHOLDER,
            idempotencyKey: `placeholder-confirm-${orderId}`
          }
        });
      }
      await applyOrderTransition(tx, {
        order: current,
        toStatus: OrderStatus.CONFIRMED,
        context: "PAYMENT_CONFIRMATION",
        actorId,
        reason: "Placeholder payment confirmed and order entered matching",
        metadata: { paymentMethod: "KASPI_PLACEHOLDER", charged: false }
      });
      await tx.auditEvent.create({
        data: {
          actorId,
          action: "PLACEHOLDER_PAYMENT_CONFIRMED",
          target: `order:${orderId}`,
          metadata: { charged: false }
        }
      });
      confirmed = {
        ...current,
        status: OrderStatus.CONFIRMED,
        version: current.version + 1
      };
    }

    const assignment = await assignConfirmedOrderInTransaction(
      tx,
      confirmed,
      actorId,
      current.status === OrderStatus.PRICED ? "CONFIRM_PLACEHOLDER" : "RETRY_CONFIRMED"
    );
    return { assignment, alreadyProcessed: false };
  });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: publicOrderInclude
  });
  const payment = await prisma.payment.findFirst({
    where: {
      orderId,
      kind: PaymentKind.CLIENT_KASPI_PLACEHOLDER
    },
    orderBy: { createdAt: "desc" }
  });
  return {
    order,
    payment,
    matchingStatus: order.status === OrderStatus.CONFIRMED ? "PENDING" : "ASSIGNED",
    alreadyProcessed: transactionResult.alreadyProcessed,
    assignment: transactionResult.assignment
  };
}

async function notifyAssignmentResult(
  result: Awaited<ReturnType<typeof confirmPlaceholderAndAssign>>,
  notifyPending = true
) {
  if (!result.assignment) {
    if (notifyPending && result.order.status === OrderStatus.CONFIRMED) {
      await createNotification({
        userId: result.order.clientId,
        type: "MATCHING_PENDING",
        title: "Ищем подходящего исполнителя",
        body: "Заказ подтверждён. Подбор продолжится автоматически, когда появится доступный исполнитель.",
        metadata: { orderId: result.order.id }
      });
    }
    return;
  }
  await Promise.all([
    createNotification({
      userId: result.assignment.executorId,
      type: "ORDER_ASSIGNED",
      title: "Новый назначенный заказ",
      body: `Вам назначен заказ ${result.order.id}.`,
      metadata: { orderId: result.order.id, score: result.assignment.score }
    }),
    createNotification({
      userId: result.order.clientId,
      type: "EXECUTOR_ASSIGNED",
      title: "Исполнитель назначен",
      body: `На ваш заказ назначен исполнитель ${result.assignment.executorName}.`,
      metadata: {
        orderId: result.order.id,
        executorId: result.assignment.executorId
      }
    })
  ]);
}

async function notifyAiFailure(input: {
  module: string;
  warning: string | null;
  orderId?: string | null;
}) {
  if (!input.warning || input.warning.startsWith("INSUFFICIENT_HISTORY")) return;
  const recipients = await prisma.user.findMany({
    where: {
      role: {
        in: [
          Role.OPERATOR,
          Role.QUALITY_MANAGER,
          Role.MANAGER,
          Role.ADMIN
        ]
      }
    },
    select: { id: true }
  });
  if (recipients.length === 0) return;
  await prisma.notification.createMany({
    data: recipients.map((recipient) => ({
      userId: recipient.id,
      type: "AI_PROVIDER_WARNING",
      title: `AI-модуль ${input.module} требует внимания`,
      body: `OpenAI-анализ не завершён: ${input.warning}`,
      metadata: {
        module: input.module,
        orderId: input.orderId ?? null,
        warning: input.warning
      }
    }))
  });
}

async function runAndStoreOrderRisk(orderId: string, trigger: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      executor: {
        select: {
          activeOrders: true,
          rating: true,
          completedOrders: true
        }
      }
    }
  });
  if (!order) return null;
  const [previousDisputes, clientReviewStats, clientOrderCount] = await Promise.all([
    prisma.dispute.count({ where: { orderId } }),
    prisma.review.aggregate({
      where: { clientId: order.clientId },
      _avg: { rating: true }
    }),
    prisma.order.count({ where: { clientId: order.clientId } })
  ]);
  const risk = await assessOrderRisk({
    orderId,
    status: order.status,
    urgent: order.urgent,
    complexityScore: order.complexityScore,
    priceTotal: order.priceTotal,
    hasExecutor: Boolean(order.executorId),
    executorActiveOrders: order.executor?.activeOrders,
    executorRating: order.executor?.rating,
    executorCompletedOrders: order.executor?.completedOrders,
    clientOrderCount,
    clientAverageRating: clientReviewStats._avg.rating ?? undefined,
    previousDisputes
  });
  const event = await prisma.aiEvent.create({
    data: {
      orderId,
      module: "ORDER_RISK",
      input: {
        trigger,
        status: order.status,
        urgent: order.urgent,
        complexityScore: order.complexityScore,
        previousDisputes,
        clientOrderCount,
        clientAverageRating: clientReviewStats._avg.rating,
        executorActiveOrders: order.executor?.activeOrders ?? null
      },
      output: jsonValue(risk),
      explanation: [
        `Trigger: ${trigger}`,
        risk.data.summary,
        ...risk.data.reasons,
        ...risk.data.recommendedActions
      ]
    }
  });
  await notifyAiFailure({
    module: "ORDER_RISK",
    warning: risk.warning,
    orderId
  });
  return { risk, event };
}

async function safelyTriggerOrderRisk(orderId: string, trigger: string) {
  try {
    return await runAndStoreOrderRisk(orderId, trigger);
  } catch (error) {
    app.log.error({ error, orderId, trigger }, "order-risk trigger failed");
    return null;
  }
}

app.get("/health", async () => {
  return { ok: true, service: "ai-cleaning-api" };
});

app.get("/ai/status", async () => {
  let databaseWarning: string | null = null;
  const recentFallbacks = await prisma.aiEvent.findMany({
    where: {
      module: {
        in: ["QUALITY_VISION", "ORDER_RISK", "DEMAND_FORECAST", "REVIEW_NLP"]
      }
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      orderId: true,
      module: true,
      output: true,
      createdAt: true
    }
  }).catch((error: unknown) => {
    databaseWarning =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "AI event history is unavailable";
    return [];
  });
  const warnings = recentFallbacks
    .map((event) => {
      const output = event.output as {
        mode?: unknown;
        warning?: unknown;
        model?: unknown;
      };
      if (output.mode !== "FALLBACK" || typeof output.warning !== "string") return null;
      return {
        eventId: event.id,
        orderId: event.orderId,
        module: event.module,
        warning: output.warning,
        model: typeof output.model === "string" ? output.model : null,
        createdAt: event.createdAt
      };
    })
    .filter((warning): warning is NonNullable<typeof warning> => warning !== null)
    .slice(0, 10);
  return {
    ...getAiStatus(),
    push: getPushStatus(),
    healthy:
      Boolean(process.env.OPENAI_API_KEY?.trim()) &&
      warnings.length === 0 &&
      databaseWarning === null,
    recentWarnings: warnings,
    databaseWarning
  };
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
        role: input.role as Role,
        executorProfile: input.role === "EXECUTOR"
          ? {
              create: {
                verified: true,
                active: true,
                acceptingJobs: true,
                online: true,
                lastSeenAt: new Date()
              }
            }
          : undefined
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
      role: input.role as Role,
      executorProfile: input.role === "EXECUTOR"
        ? {
            create: {
              verified: false,
              active: false,
              acceptingJobs: false,
              online: true,
              lastSeenAt: new Date()
            }
          }
        : undefined
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

app.patch("/users/me/profile", async (request) => {
  const user = await requireUser(request);
  const input = updateProfileSchema.parse(request.body);
  const existing = await prisma.user.findFirst({
    where: {
      id: { not: user.id },
      OR: [
        ...(input.email ? [{ email: input.email }] : []),
        ...(input.phone ? [{ phone: input.phone }] : [])
      ]
    }
  });
  if (existing) {
    throw apiError("USER_ALREADY_EXISTS", "Email or phone is already in use", 409);
  }

  const changedFields = [
    user.name !== input.name ? "name" : null,
    user.email !== input.email ? "email" : null,
    user.phone !== input.phone ? "phone" : null
  ].filter((field): field is string => field !== null);

  const updated = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: user.id },
      data: {
        name: input.name,
        email: input.email,
        phone: input.phone
      }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "USER_PROFILE_UPDATED",
        target: `user:${user.id}`,
        metadata: { changedFields }
      }
    });
    return updatedUser;
  });

  return { user: publicUser(updated) };
});

app.patch("/users/me/password", async (request) => {
  const user = await requireUser(request);
  const input = changePasswordSchema.parse(request.body);
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    throw apiError("AUTH_CURRENT_PASSWORD_INVALID", "Current password is invalid", 401);
  }
  if (verifyPassword(input.newPassword, user.passwordHash)) {
    throw apiError("PASSWORD_REUSE", "New password must differ from the current password", 409);
  }

  const currentToken = bearerTokenFromRequest(request);
  if (!currentToken) {
    throw apiError("AUTH_REQUIRED", "Authentication is required", 401);
  }
  const currentTokenHash = hashToken(currentToken);

  const revokedSessions = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(input.newPassword) }
    });
    const revoked = await tx.session.deleteMany({
      where: {
        userId: user.id,
        tokenHash: { not: currentTokenHash }
      }
    });
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        action: "USER_PASSWORD_CHANGED",
        target: `user:${user.id}`,
        metadata: { revokedSessions: revoked.count }
      }
    });
    await tx.notification.create({
      data: {
        userId: user.id,
        type: "PASSWORD_CHANGED",
        title: "Пароль изменён",
        body: `Пароль аккаунта изменён. Завершено других сеансов: ${revoked.count}.`,
        metadata: { revokedSessions: revoked.count }
      }
    });
    return revoked.count;
  });

  return { ok: true, revokedSessions };
});

app.post("/auth/logout", async (request) => {
  const token = bearerTokenFromRequest(request);
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  return { ok: true };
});

app.get("/executors/me/availability", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.EXECUTOR]);
  const profile = await prisma.executorProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, online: true, lastSeenAt: new Date() },
    update: { online: true, lastSeenAt: new Date() }
  });
  return { profile };
});

app.patch("/executors/me/availability", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.EXECUTOR]);
  const input = executorAvailabilitySchema.parse(request.body);
  const profile = await prisma.executorProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      acceptingJobs: input.acceptingJobs,
      online: true,
      lastSeenAt: new Date(),
      serviceZones: input.serviceZones,
      shiftStartsAt: input.shiftStartsAt ? new Date(input.shiftStartsAt) : null,
      shiftEndsAt: input.shiftEndsAt ? new Date(input.shiftEndsAt) : null
    },
    update: {
      acceptingJobs: input.acceptingJobs,
      online: true,
      lastSeenAt: new Date(),
      serviceZones: input.serviceZones,
      shiftStartsAt: input.shiftStartsAt ? new Date(input.shiftStartsAt) : null,
      shiftEndsAt: input.shiftEndsAt ? new Date(input.shiftEndsAt) : null
    }
  });
  await prisma.auditEvent.create({
    data: {
      actorId: user.id,
      action: "EXECUTOR_AVAILABILITY_UPDATED",
      target: `user:${user.id}`,
      metadata: {
        acceptingJobs: profile.acceptingJobs,
        serviceZones: profile.serviceZones,
        shiftStartsAt: profile.shiftStartsAt,
        shiftEndsAt: profile.shiftEndsAt
      }
    }
  });
  return { profile };
});

app.post("/executors/me/heartbeat", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.EXECUTOR]);
  const profile = await prisma.executorProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, online: true, lastSeenAt: new Date() },
    update: { online: true, lastSeenAt: new Date() }
  });
  return {
    ok: true,
    serverTime: new Date(),
    eligible:
      profile.verified &&
      profile.active &&
      profile.acceptingJobs
  };
});

app.post("/devices/push-token", async (request) => {
  const user = await requireUser(request);
  const input = pushDeviceSchema.parse(request.body);
  const device = await prisma.pushDevice.upsert({
    where: { token: input.token },
    create: {
      userId: user.id,
      token: input.token,
      platform: input.platform
    },
    update: {
      userId: user.id,
      platform: input.platform,
      enabled: true
    }
  });
  return { device: { id: device.id, platform: device.platform, enabled: device.enabled } };
});

app.get("/operations/executors", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  return prisma.user.findMany({
    where: { role: Role.EXECUTOR },
    orderBy: [{ createdAt: "desc" }],
    select: publicUserSelect
  });
});

app.patch("/operations/executors/:id", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  const { id } = request.params as { id: string };
  const input = manageExecutorSchema.parse(request.body);
  const executor = await prisma.user.findUnique({ where: { id } });
  if (!executor || executor.role !== Role.EXECUTOR) {
    throw apiError("EXECUTOR_NOT_FOUND", "Executor not found", 404);
  }
  const profile = await prisma.executorProfile.upsert({
    where: { userId: id },
    create: {
      userId: id,
      verified: input.verified ?? false,
      active: input.active ?? false,
      acceptingJobs: input.acceptingJobs ?? false,
      serviceZones: input.serviceZones ?? [],
      shiftStartsAt: input.shiftStartsAt ? new Date(input.shiftStartsAt) : null,
      shiftEndsAt: input.shiftEndsAt ? new Date(input.shiftEndsAt) : null
    },
    update: {
      verified: input.verified,
      active: input.active,
      acceptingJobs: input.acceptingJobs,
      serviceZones: input.serviceZones,
      shiftStartsAt:
        input.shiftStartsAt === undefined
          ? undefined
          : input.shiftStartsAt
            ? new Date(input.shiftStartsAt)
            : null,
      shiftEndsAt:
        input.shiftEndsAt === undefined
          ? undefined
          : input.shiftEndsAt
            ? new Date(input.shiftEndsAt)
            : null
    }
  });
  await prisma.auditEvent.create({
    data: {
      actorId: user.id,
      action: "EXECUTOR_ELIGIBILITY_UPDATED",
      target: `user:${id}`,
      metadata: jsonValue(input)
    }
  });
  return { executor: { ...publicUser(executor), executorProfile: profile } };
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
      reviews: true,
      aiEvents: {
        where: { module: { in: ["QUALITY_VISION", "ORDER_RISK"] } },
        orderBy: { createdAt: "desc" },
        take: 6
      }
    }
  });
});

app.post("/reviews", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const input = createReviewSchema.parse(request.body);
  assertSelfOrRole(user, input.clientId, []);
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { service: true }
  });
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

  const nlp = await analyzeReview({
    reviewId: review.id,
    orderId: order.id,
    rating: review.rating,
    comment: review.comment ?? undefined,
    serviceTitle: order.service.title
  });
  await prisma.aiEvent.create({
    data: {
      orderId: order.id,
      module: "REVIEW_NLP",
      input: {
        reviewId: review.id,
        rating: review.rating,
        hasComment: Boolean(review.comment)
      },
      output: jsonValue(nlp),
      explanation: [nlp.data.summary, nlp.data.recommendedAction]
    }
  });

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

  return { review, nlp };
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
  const executor = await prisma.user.findUnique({
    where: { id: input.executorId },
    include: { executorProfile: true }
  });
  if (!executor || executor.role !== Role.EXECUTOR) {
    throw apiError("EXECUTOR_NOT_FOUND", "Executor not found", 404);
  }
  if (
    !executor.executorProfile?.verified ||
    !executor.executorProfile.active ||
    !executor.executorProfile.acceptingJobs
  ) {
    throw apiError(
      "EXECUTOR_NOT_ELIGIBLE",
      "Executor must be verified, active, and accepting jobs",
      409
    );
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
  await safelyTriggerOrderRisk(order.id, "ORDER_CREATED");

  return { order };
});

app.post("/orders/:id/confirm-placeholder", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [Role.CLIENT]);
  const { id } = request.params as { id: string };
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  if (existing.clientId !== user.id) {
    throw apiError("ORDER_FORBIDDEN", "Client does not own order", 403);
  }
  const result = await confirmPlaceholderAndAssign(id, user.id);
  await notifyAssignmentResult(result);
  await safelyTriggerOrderRisk(
    id,
    result.order.status === OrderStatus.ASSIGNED
      ? "ORDER_CONFIRMED_AND_ASSIGNED"
      : "ORDER_CONFIRMED_MATCHING_PENDING"
  );
  return result;
});

app.post("/orders/:id/retry-assignment", async (request) => {
  const user = await requireUser(request);
  const { id } = request.params as { id: string };
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  const allowed =
    (user.role === Role.CLIENT && existing.clientId === user.id) ||
    hasAnyRole(user, OPERATION_ROLES);
  if (!allowed) {
    throw apiError("ORDER_ASSIGN_FORBIDDEN", "You cannot retry this order", 403);
  }
  if (existing.status !== OrderStatus.CONFIRMED) {
    throw apiError(
      "ORDER_NOT_AWAITING_ASSIGNMENT",
      "Only a confirmed order can be put back into matching",
      409,
      { status: existing.status }
    );
  }
  const result = await confirmPlaceholderAndAssign(id, user.id);
  await notifyAssignmentResult(result);
  await safelyTriggerOrderRisk(
    id,
    result.order.status === OrderStatus.ASSIGNED
      ? "ORDER_REASSIGNED"
      : "ORDER_RETRY_NO_EXECUTOR"
  );
  return result;
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
  const executors = await prisma.user.findMany({
    where: {
      role: Role.EXECUTOR,
      executorProfile: {
        is: {
          verified: true,
          active: true,
          acceptingJobs: true
        }
      }
    },
    include: { executorProfile: true }
  });
  const assignmentTime = existingOrder.scheduledAt ?? new Date();
  const ranked = executors
    .filter((executor) => {
      const profile = executor.executorProfile;
      if (!profile) return false;
      if (
        existingOrder.serviceZone &&
        profile.serviceZones.length > 0 &&
        !profile.serviceZones.includes(existingOrder.serviceZone)
      ) {
        return false;
      }
      if (profile.shiftStartsAt && assignmentTime < profile.shiftStartsAt) return false;
      if (profile.shiftEndsAt && assignmentTime > profile.shiftEndsAt) return false;
      return true;
    })
    .map((executor) => ({
      executor,
      score:
        scoreExecutor({
          id: executor.id,
          name: executor.name,
          distanceKm: executor.distanceKm,
          rating: executor.rating,
          activeOrders: executor.activeOrders,
          completedOrders: executor.completedOrders
        }) +
        (
          executor.executorProfile?.online &&
          executor.executorProfile.lastSeenAt &&
          executor.executorProfile.lastSeenAt.getTime() >= Date.now() - EXECUTOR_RECENTLY_ONLINE_MS
            ? 8
            : 0
        )
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

app.post("/operations/orders/retry-confirmed", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, OPERATION_ROLES);
  const confirmed = await prisma.order.findMany({
    where: { status: OrderStatus.CONFIRMED },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: { id: true }
  });
  const results = [];
  for (const order of confirmed) {
    const result = await confirmPlaceholderAndAssign(order.id, user.id);
    await notifyAssignmentResult(result);
    results.push({
      orderId: order.id,
      status: result.order.status,
      matchingStatus: result.matchingStatus,
      executorId: result.order.executorId
    });
  }
  return {
    processed: results.length,
    assigned: results.filter((result) => result.matchingStatus === "ASSIGNED").length,
    results
  };
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
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      service: true,
      executor: {
        select: {
          rating: true,
          activeOrders: true,
          completedOrders: true
        }
      }
    }
  });
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
    stage: "AFTER",
    photoUri: input.photoUri,
    photoBase64: input.photoBase64,
    fileName: input.fileName,
    mimeType: input.mimeType
  });
  const storedBeforeMedia =
    input.beforePhotoBase64 && input.beforeMimeType
      ? await saveProofMedia({
          orderId: order.id,
          stage: "BEFORE",
          photoUri: input.beforePhotoUri ?? "android://proof/before",
          photoBase64: input.beforePhotoBase64,
          fileName: input.beforeFileName,
          mimeType: input.beforeMimeType
        })
      : null;

  const afterAnalysisImages =
    storedMedia.mimeType === "video/mp4"
      ? input.analysisFramesBase64.map((frame) => {
          const validated = decodeAndValidateProofImage(frame, "image/jpeg");
          return `data:${validated.mimeType};base64,${validated.buffer.toString("base64")}`;
        })
      : [`data:${storedMedia.mimeType};base64,${input.photoBase64.replace(/\s+/g, "")}`];
  const beforeAnalysisImages = storedBeforeMedia
    ? storedBeforeMedia.mimeType === "video/mp4"
      ? input.beforeAnalysisFramesBase64.map((frame) => {
          const validated = decodeAndValidateProofImage(frame, "image/jpeg");
          return `data:${validated.mimeType};base64,${validated.buffer.toString("base64")}`;
        })
      : [
          `data:${storedBeforeMedia.mimeType};base64,${input.beforePhotoBase64?.replace(/\s+/g, "") ?? ""}`
        ]
    : [];

  const vision = await analyzeQualityVision({
    orderId: order.id,
    serviceTitle: order.service.title,
    checklist: input.checklist,
    notes: input.notes,
    mediaType: storedMedia.mimeType,
    beforeImages: beforeAnalysisImages,
    afterImages: afterAnalysisImages
  });
  const [previousDisputes, clientReviewStats, clientOrderCount] = await Promise.all([
    prisma.dispute.count({ where: { orderId: order.id } }),
    prisma.review.aggregate({
      where: { clientId: order.clientId },
      _avg: { rating: true }
    }),
    prisma.order.count({ where: { clientId: order.clientId } })
  ]);
  const risk = await assessOrderRisk({
    orderId: order.id,
    status: order.status,
    urgent: order.urgent,
    complexityScore: order.complexityScore,
    priceTotal: order.priceTotal,
    hasExecutor: Boolean(order.executorId),
    executorActiveOrders: order.executor?.activeOrders,
    executorRating: order.executor?.rating,
    executorCompletedOrders: order.executor?.completedOrders,
    clientOrderCount,
    clientAverageRating: clientReviewStats._avg.rating ?? undefined,
    previousDisputes,
    vision: vision.data
  });
  const checklistScore = vision.data.score;
  const result = await prisma.$transaction(async (tx) => {
    if (storedBeforeMedia) {
      await tx.proofAsset.create({
        data: {
          orderId: order.id,
          kind: storedBeforeMedia.kind,
          uri: storedBeforeMedia.uri,
          notes: input.notes
        }
      });
    }
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
        notes: vision.data.summary
      }
    });
    await tx.aiEvent.createMany({
      data: [
        {
          orderId: order.id,
          module: "QUALITY_VISION",
          input: {
            checklist: input.checklist,
            mediaType: storedMedia.mimeType,
            beforeFrameCount: beforeAnalysisImages.length,
            afterFrameCount: afterAnalysisImages.length,
            hasBeforeAfterPair:
              beforeAnalysisImages.length > 0 && afterAnalysisImages.length > 0,
            hasNotes: Boolean(input.notes)
          },
          output: jsonValue(vision),
          explanation: [
            vision.data.summary,
            ...vision.data.detectedIssues,
            ...vision.data.recommendations
          ]
        },
        {
          orderId: order.id,
          module: "ORDER_RISK",
          input: {
            status: order.status,
            urgent: order.urgent,
            complexityScore: order.complexityScore,
            previousDisputes,
            clientOrderCount,
            clientAverageRating: clientReviewStats._avg.rating,
            executorActiveOrders: order.executor?.activeOrders ?? null,
            qualityVisionMode: vision.mode
          },
          output: jsonValue(risk),
          explanation: [
            risk.data.summary,
            ...risk.data.reasons,
            ...risk.data.recommendedActions
          ]
        }
      ]
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
          media: {
            uri: proof.uri,
            kind: proof.kind,
            sizeBytes: storedMedia.sizeBytes,
            mimeType: storedMedia.mimeType,
            beforeFrameCount: beforeAnalysisImages.length,
            afterFrameCount: afterAnalysisImages.length,
            beforeUri: storedBeforeMedia?.uri ?? null
          },
          ai: {
            qualityMode: vision.mode,
            qualityScore: vision.data.score,
            riskLevel: risk.data.level
          }
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
  const scoreText =
    vision.data.score === null
      ? "оценка не выставлена, требуется ручная проверка"
      : `${vision.data.score}/100`;

  await Promise.all([
    createNotification({
      userId: order.clientId,
      type: "QUALITY_CHECK",
      title: "Заказ передан на контроль качества",
      body: `По заказу ${order.id} отправлен медиаотчёт. AI Quality: ${scoreText}.`,
      metadata: {
        orderId: order.id,
        qualityCheckId: qualityCheck.id,
        proofId: proof.id,
        aiMode: vision.mode,
        aiScore: vision.data.score
      }
    }),
    createNotification({
      userId: order.executorId,
      type: "PROOF_SUBMITTED",
      title: "Медиаотчёт отправлен",
      body: `Ваш отчёт по заказу ${order.id} сохранён. AI Quality: ${scoreText}.`,
      metadata: {
        orderId: order.id,
        qualityCheckId: qualityCheck.id,
        proofId: proof.id,
        aiMode: vision.mode,
        aiScore: vision.data.score
      }
    })
  ]);
  await Promise.all([
    notifyAiFailure({
      module: "QUALITY_VISION",
      warning: vision.warning,
      orderId: order.id
    }),
    notifyAiFailure({
      module: "ORDER_RISK",
      warning: risk.warning,
      orderId: order.id
    })
  ]);

  return {
    proof,
    qualityCheck,
    order: updatedOrder,
    aiAnalysis: {
      quality: vision,
      risk
    }
  };
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

app.get("/quality/:orderId/ai-analysis", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [...QUALITY_ROLES, ...OPERATION_ROLES]);
  const { orderId } = request.params as { orderId: string };
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  const events = await prisma.aiEvent.findMany({
    where: {
      orderId,
      module: { in: ["QUALITY_VISION", "ORDER_RISK"] }
    },
    orderBy: { createdAt: "desc" },
    take: 4
  });
  return {
    orderId,
    quality: events.find((event) => event.module === "QUALITY_VISION") ?? null,
    risk: events.find((event) => event.module === "ORDER_RISK") ?? null
  };
});

app.post("/ai/risk/:orderId", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, [...QUALITY_ROLES, ...OPERATION_ROLES]);
  const { orderId } = request.params as { orderId: string };
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      executor: {
        select: {
          activeOrders: true,
          rating: true,
          completedOrders: true
        }
      }
    }
  });
  if (!order) throw apiError("ORDER_NOT_FOUND", "Order not found", 404);
  const [previousDisputes, clientReviewStats, clientOrderCount] = await Promise.all([
    prisma.dispute.count({ where: { orderId } }),
    prisma.review.aggregate({
      where: { clientId: order.clientId },
      _avg: { rating: true }
    }),
    prisma.order.count({ where: { clientId: order.clientId } })
  ]);
  const result = await assessOrderRisk({
    orderId,
    status: order.status,
    urgent: order.urgent,
    complexityScore: order.complexityScore,
    priceTotal: order.priceTotal,
    hasExecutor: Boolean(order.executorId),
    executorActiveOrders: order.executor?.activeOrders,
    executorRating: order.executor?.rating,
    executorCompletedOrders: order.executor?.completedOrders,
    clientOrderCount,
    clientAverageRating: clientReviewStats._avg.rating ?? undefined,
    previousDisputes
  });
  const event = await prisma.aiEvent.create({
    data: {
      orderId,
      module: "ORDER_RISK",
      input: {
        status: order.status,
        urgent: order.urgent,
        complexityScore: order.complexityScore,
        previousDisputes,
        clientOrderCount,
        clientAverageRating: clientReviewStats._avg.rating,
        executorActiveOrders: order.executor?.activeOrders ?? null
      },
      output: jsonValue(result),
      explanation: [
        result.data.summary,
        ...result.data.reasons,
        ...result.data.recommendedActions
      ]
    }
  });
  return { risk: result, eventId: event.id };
});

app.post("/ai/forecast", async (request) => {
  const user = await requireUser(request);
  requireAnyRole(user, ANALYTICS_ROLES);
  const input = forecastRequestSchema.parse(request.body ?? {});
  const historyStart = new Date();
  historyStart.setUTCHours(0, 0, 0, 0);
  historyStart.setUTCDate(historyStart.getUTCDate() - 59);
  const [orders, activeExecutors, currentActiveOrders] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: historyStart } },
      select: { createdAt: true }
    }),
    prisma.user.count({ where: { role: Role.EXECUTOR } }),
    prisma.order.count({
      where: {
        status: {
          in: [
            OrderStatus.ASSIGNED,
            OrderStatus.ACCEPTED,
            OrderStatus.IN_PROGRESS,
            OrderStatus.QUALITY_CHECK
          ]
        }
      }
    })
  ]);
  const dailyCounts = new Map<string, number>();
  for (let offset = 0; offset < 60; offset += 1) {
    const date = new Date(historyStart);
    date.setUTCDate(date.getUTCDate() + offset);
    dailyCounts.set(date.toISOString().slice(0, 10), 0);
  }
  for (const order of orders) {
    const date = order.createdAt.toISOString().slice(0, 10);
    dailyCounts.set(date, (dailyCounts.get(date) ?? 0) + 1);
  }
  const dailyOrders = [...dailyCounts.entries()].map(([date, count]) => ({
    date,
    orders: count
  }));
  const result = await forecastDemand({
    horizonDays: input.horizonDays,
    dailyOrders,
    activeExecutors,
    currentActiveOrders
  });
  const event = await prisma.aiEvent.create({
    data: {
      module: "DEMAND_FORECAST",
      input: {
        horizonDays: input.horizonDays,
        historyDays: dailyOrders.length,
        activeExecutors,
        currentActiveOrders
      },
      output: jsonValue(result),
      explanation: [
        result.data.summary,
        ...result.data.risks,
        ...result.data.staffingRecommendations
      ]
    }
  });
  return { forecast: result, eventId: event.id };
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

async function retryStuckConfirmedOrders() {
  const retryBefore = new Date(Date.now() - 30_000);
  const stuck = await prisma.order.findMany({
    where: {
      status: OrderStatus.CONFIRMED,
      updatedAt: { lte: retryBefore }
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
    select: { id: true, clientId: true }
  });
  for (const order of stuck) {
    try {
      const result = await confirmPlaceholderAndAssign(order.id, order.clientId);
      await notifyAssignmentResult(result, false);
      if (result.assignment) {
        await safelyTriggerOrderRisk(order.id, "AUTOMATIC_RETRY_ASSIGNED");
      }
    } catch (error) {
      app.log.error({ error, orderId: order.id }, "confirmed-order retry failed");
    }
  }
}

async function scanDelayedOrders() {
  const delayBefore = new Date(Date.now() - 30 * 60 * 1000);
  const candidates = await prisma.order.findMany({
    where: {
      status: {
        in: [
          OrderStatus.CONFIRMED,
          OrderStatus.ASSIGNED,
          OrderStatus.ACCEPTED,
          OrderStatus.IN_PROGRESS,
          OrderStatus.QUALITY_CHECK
        ]
      },
      OR: [
        { updatedAt: { lte: delayBefore } },
        { scheduledAt: { lte: new Date() } }
      ]
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
    select: { id: true }
  });
  const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
  for (const order of candidates) {
    const recentRisk = await prisma.aiEvent.findFirst({
      where: {
        orderId: order.id,
        module: "ORDER_RISK",
        createdAt: { gte: recentCutoff }
      },
      select: { id: true }
    });
    if (recentRisk) continue;
    try {
      await safelyTriggerOrderRisk(order.id, "ORDER_DELAY_DETECTED");
    } catch (error) {
      app.log.error({ error, orderId: order.id }, "delayed-order AI trigger failed");
    }
  }
}

const port = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== "test") {
  app.listen({ port, host: "0.0.0.0" }).catch(async (error) => {
    app.log.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
  const matchingRetryTimer = setInterval(() => {
    void retryStuckConfirmedOrders();
  }, 60_000);
  matchingRetryTimer.unref();
  const delayScanTimer = setInterval(() => {
    void scanDelayedOrders();
  }, 5 * 60_000);
  delayScanTimer.unref();
}
