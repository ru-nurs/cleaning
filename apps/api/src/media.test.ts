import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import {
  decodeAndValidateProofImage,
  extensionForProofMimeType
} from "./media.js";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6N8AAAAASUVORK5CYII=";

test("a valid PNG proof is accepted from its file signature", () => {
  const result = decodeAndValidateProofImage(onePixelPng, "image/png");
  assert.equal(result.mimeType, "image/png");
  assert.ok(result.buffer.length > 0);
  assert.equal(extensionForProofMimeType(result.mimeType), ".png");
});

test("invalid base64 is rejected", () => {
  assert.throws(
    () => decodeAndValidateProofImage("not-base64!", "image/png"),
    (error) => error instanceof ApiError && error.code === "PROOF_INVALID_BASE64"
  );
});

test("declared MIME type must match the actual image", () => {
  assert.throws(
    () => decodeAndValidateProofImage(onePixelPng, "image/jpeg"),
    (error) => error instanceof ApiError && error.code === "PROOF_MIME_MISMATCH"
  );
});
