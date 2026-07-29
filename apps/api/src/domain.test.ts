import assert from "node:assert/strict";
import test from "node:test";
import { OrderStatus, Role } from "@prisma/client";
import {
  ORDER_TRANSITION_RULES,
  assertExecutorProgress,
  assertOrderTransition,
  orderScopeForRole
} from "./domain.js";
import { ApiError } from "./errors.js";

test("the state machine contains every transition from the MVP specification", () => {
  assert.equal(ORDER_TRANSITION_RULES.length, 11);
  for (const rule of ORDER_TRANSITION_RULES) {
    for (const context of rule.contexts) {
      assert.doesNotThrow(() => assertOrderTransition(rule.from, rule.to, context));
    }
  }
});

test("an invalid order transition returns a stable business error", () => {
  assert.throws(
    () =>
      assertOrderTransition(
        OrderStatus.PRICED,
        OrderStatus.COMPLETED,
        "EXECUTOR_PROGRESS"
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "ORDER_INVALID_TRANSITION");
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test("only the assigned executor can accept and start an order", () => {
  const executor = { id: "executor-1", role: Role.EXECUTOR };
  const assignedOrder = {
    executorId: "executor-1",
    status: OrderStatus.ASSIGNED
  };

  assert.doesNotThrow(() =>
    assertExecutorProgress(executor, assignedOrder, OrderStatus.ACCEPTED)
  );

  assert.throws(
    () =>
      assertExecutorProgress(
        { id: "executor-2", role: Role.EXECUTOR },
        assignedOrder,
        OrderStatus.ACCEPTED
      ),
    (error) => error instanceof ApiError && error.code === "ORDER_EXECUTOR_REQUIRED"
  );
});

test("order lists are scoped by the authenticated role", () => {
  assert.deepEqual(orderScopeForRole({ id: "client-1", role: Role.CLIENT }), {
    clientId: "client-1"
  });
  assert.deepEqual(orderScopeForRole({ id: "executor-1", role: Role.EXECUTOR }), {
    executorId: "executor-1"
  });
  assert.deepEqual(orderScopeForRole({ id: "admin-1", role: Role.ADMIN }), {});
  assert.deepEqual(
    orderScopeForRole({ id: "quality-1", role: Role.QUALITY_MANAGER }),
    {
      status: { in: [OrderStatus.QUALITY_CHECK, OrderStatus.DISPUTE] }
    }
  );
});
