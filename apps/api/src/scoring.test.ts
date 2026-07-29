import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateOrderPrice,
  scoreExecutor
} from "@ai-cleaning/shared";

test("pricing is deterministic and returns an explanation", () => {
  const input = {
    serviceId: "standard_apartment",
    rooms: 2,
    areaSqm: 45,
    hasPets: false,
    urgent: false
  };
  const first = estimateOrderPrice(input);
  const second = estimateOrderPrice(input);

  assert.deepEqual(first, second);
  assert.equal(first.total, 3_600);
  assert.equal(first.complexityScore, 40);
  assert.ok(first.explanation.length >= 4);
});

test("matching rewards rating and lower active load", () => {
  const available = scoreExecutor({
    id: "available",
    name: "Available",
    distanceKm: 2,
    rating: 4.9,
    activeOrders: 0,
    completedOrders: 80
  });
  const overloaded = scoreExecutor({
    id: "overloaded",
    name: "Overloaded",
    distanceKm: 2,
    rating: 4.4,
    activeOrders: 4,
    completedOrders: 80
  });

  assert.ok(available > overloaded);
});
