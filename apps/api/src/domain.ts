import { OrderStatus, Role } from "@prisma/client";
import { apiError } from "./errors.js";

export type TransitionContext =
  | "SYSTEM_PRICING"
  | "PAYMENT_CONFIRMATION"
  | "MATCHING"
  | "MANUAL_ASSIGNMENT"
  | "EXECUTOR_PROGRESS"
  | "PROOF_SUBMISSION"
  | "REWORK_SUBMISSION"
  | "QUALITY_DECISION"
  | "PAYOUT_RELEASE";

type TransitionRule = {
  from: OrderStatus;
  to: OrderStatus;
  contexts: TransitionContext[];
};

export const ORDER_TRANSITION_RULES: TransitionRule[] = [
  {
    from: OrderStatus.CREATED,
    to: OrderStatus.PRICED,
    contexts: ["SYSTEM_PRICING"]
  },
  {
    from: OrderStatus.PRICED,
    to: OrderStatus.CONFIRMED,
    contexts: ["PAYMENT_CONFIRMATION"]
  },
  {
    from: OrderStatus.CONFIRMED,
    to: OrderStatus.ASSIGNED,
    contexts: ["MATCHING", "MANUAL_ASSIGNMENT"]
  },
  {
    from: OrderStatus.ASSIGNED,
    to: OrderStatus.ACCEPTED,
    contexts: ["EXECUTOR_PROGRESS"]
  },
  {
    from: OrderStatus.ACCEPTED,
    to: OrderStatus.IN_PROGRESS,
    contexts: ["EXECUTOR_PROGRESS"]
  },
  {
    from: OrderStatus.IN_PROGRESS,
    to: OrderStatus.QUALITY_CHECK,
    contexts: ["PROOF_SUBMISSION"]
  },
  {
    from: OrderStatus.QUALITY_CHECK,
    to: OrderStatus.COMPLETED,
    contexts: ["QUALITY_DECISION"]
  },
  {
    from: OrderStatus.QUALITY_CHECK,
    to: OrderStatus.DISPUTE,
    contexts: ["QUALITY_DECISION"]
  },
  {
    from: OrderStatus.DISPUTE,
    to: OrderStatus.QUALITY_CHECK,
    contexts: ["REWORK_SUBMISSION"]
  },
  {
    from: OrderStatus.DISPUTE,
    to: OrderStatus.COMPLETED,
    contexts: ["QUALITY_DECISION"]
  },
  {
    from: OrderStatus.COMPLETED,
    to: OrderStatus.PAYMENT_RELEASED,
    contexts: ["PAYOUT_RELEASE"]
  }
];

export const OPERATION_ROLES = [Role.OPERATOR, Role.MANAGER, Role.ADMIN] as const;
export const QUALITY_ROLES = [Role.QUALITY_MANAGER, Role.MANAGER, Role.ADMIN] as const;
export const ANALYTICS_ROLES = [Role.MANAGER, Role.ADMIN] as const;
export const PRIVILEGED_ORDER_ROLES = [
  Role.OPERATOR,
  Role.QUALITY_MANAGER,
  Role.MANAGER,
  Role.ADMIN
] as const;

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
  context: TransitionContext
) {
  const allowed = ORDER_TRANSITION_RULES.some(
    (rule) => rule.from === from && rule.to === to && rule.contexts.includes(context)
  );
  if (!allowed) {
    throw apiError(
      "ORDER_INVALID_TRANSITION",
      `Order cannot move from ${from} to ${to}`,
      409,
      { from, to, context }
    );
  }
}

export function assertExecutorProgress(
  user: { id: string; role: Role },
  order: { executorId: string | null; status: OrderStatus },
  nextStatus: OrderStatus
) {
  if (user.role !== Role.EXECUTOR || order.executorId !== user.id) {
    throw apiError(
      "ORDER_EXECUTOR_REQUIRED",
      "Only the assigned executor can progress this order",
      403
    );
  }
  assertOrderTransition(order.status, nextStatus, "EXECUTOR_PROGRESS");
}

export function orderScopeForRole(user: { id: string; role: Role }) {
  switch (user.role) {
    case Role.CLIENT:
      return { clientId: user.id };
    case Role.EXECUTOR:
      return { executorId: user.id };
    case Role.QUALITY_MANAGER:
      return { status: { in: [OrderStatus.QUALITY_CHECK, OrderStatus.DISPUTE] } };
    case Role.OPERATOR:
    case Role.MANAGER:
    case Role.ADMIN:
      return {};
  }
}
