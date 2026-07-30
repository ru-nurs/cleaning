import assert from "node:assert/strict";
import test from "node:test";
import {
  isStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH
} from "./passwordPolicy.js";

test("password policy requires 12 characters, a Latin letter, and a digit", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(isStrongPassword("Strong-password-1"), true);
  assert.equal(isStrongPassword("short1"), false);
  assert.equal(isStrongPassword("onlyletterslong"), false);
  assert.equal(isStrongPassword("123456789012"), false);
  assert.equal(isStrongPassword("Парольпароль1"), false);
  assert.equal(isStrongPassword(`A1${"x".repeat(PASSWORD_MAX_LENGTH - 2)}`), true);
  assert.equal(isStrongPassword(`A1${"x".repeat(PASSWORD_MAX_LENGTH - 1)}`), false);
});
