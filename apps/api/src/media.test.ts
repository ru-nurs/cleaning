import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import {
  decodeAndValidateProofImage,
  decodeAndValidateProofMedia,
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

test("a valid MP4 proof is accepted and receives an mp4 extension", () => {
  const mp4Header = Buffer.from([
    0x00, 0x00, 0x00, 0x0c,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d
  ]).toString("base64");
  const result = decodeAndValidateProofMedia(mp4Header, "video/mp4");
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(extensionForProofMimeType(result.mimeType), ".mp4");
});
