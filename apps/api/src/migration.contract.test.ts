import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../prisma/migrations/202607300001_mvp_hardening/migration.sql",
  import.meta.url
);

test("the MVP migration contains required state, audit, dispute and idempotency structures", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const requiredStatement of [
    'CREATE TYPE "Role"',
    'CREATE TYPE "OrderStatus"',
    'CREATE TYPE "PaymentStatus"',
    'CREATE TYPE "QualityCheckStatus"',
    'CREATE TABLE "OrderStatusHistory"',
    'CREATE TABLE "Dispute"',
    'CREATE UNIQUE INDEX "Review_orderId_clientId_key"',
    'CREATE UNIQUE INDEX "Payment_idempotencyKey_key"',
    'CREATE INDEX "Order_status_idx"',
    'CREATE INDEX "Order_clientId_idx"',
    'CREATE INDEX "Order_executorId_idx"'
  ]) {
    assert.match(sql, new RegExp(requiredStatement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("database seed cannot publish a fixed password or create demo users in production", async () => {
  const seed = await readFile(new URL("../prisma/seed.ts", import.meta.url), "utf8");

  assert.doesNotMatch(seed, /password1/);
  assert.match(seed, /SEED_DEMO_PASSWORD/);
  assert.match(seed, /NODE_ENV === "production"/);
  assert.match(seed, /Demo users cannot be seeded in production/);
});
