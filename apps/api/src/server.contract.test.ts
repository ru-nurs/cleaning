import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { demoLoginEnabled } from "./config.js";

process.env.NODE_ENV = "test";

test("health and validation failures use stable response contracts", async () => {
  const { app } = await import("./server.js");

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true, service: "ai-cleaning-api" });

  const aiStatus = await app.inject({ method: "GET", url: "/ai/status" });
  assert.equal(aiStatus.statusCode, 200);
  assert.equal(typeof aiStatus.json().enabled, "boolean");
  assert.ok(aiStatus.json().modules.includes("QUALITY_VISION"));

  const invalid = await app.inject({ method: "GET", url: "/geo/geocode?address=x" });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
  assert.equal(typeof invalid.json().error.requestId, "string");

  const unauthorized = await app.inject({ method: "GET", url: "/auth/me" });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error.code, "AUTH_REQUIRED");

  const missing = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "ROUTE_NOT_FOUND");

  await app.close();
});

test("demo login is disabled by production configuration", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.equal(demoLoginEnabled(), false);
  process.env.NODE_ENV = previous;
});

test("OpenAPI documents every implemented route and method", async () => {
  const [serverSource, openApiSource] = await Promise.all([
    readFile(new URL("./server.ts", import.meta.url), "utf8"),
    readFile(new URL("../openapi.yaml", import.meta.url), "utf8")
  ]);

  const implemented = new Set<string>();
  const routePattern = /app\.(get|post|put|patch|delete)\("([^"]+)"/g;
  for (const match of serverSource.matchAll(routePattern)) {
    implemented.add(`${match[1].toUpperCase()} ${match[2]}`);
  }

  const documented = new Set<string>();
  let currentPath = "";
  for (const line of openApiSource.split(/\r?\n/)) {
    const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1].replace(/\{([^}]+)\}/g, ":$1");
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete):\s*$/.exec(line);
    if (currentPath && methodMatch) {
      documented.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }

  assert.deepEqual([...documented].sort(), [...implemented].sort());
});
