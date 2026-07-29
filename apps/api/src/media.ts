import { appConfig } from "./config.js";
import { apiError } from "./errors.js";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function detectedMimeType(buffer: Buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function decodeAndValidateProofImage(photoBase64: string, declaredMimeType?: string) {
  const normalized = photoBase64.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw apiError("PROOF_INVALID_BASE64", "Proof image is not valid base64", 400);
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) {
    throw apiError("PROOF_EMPTY", "Proof image is empty", 400);
  }
  if (buffer.length > appConfig.maxProofBytes) {
    throw apiError(
      "PROOF_TOO_LARGE",
      `Proof image exceeds ${appConfig.maxProofBytes} bytes`,
      413,
      { maxBytes: appConfig.maxProofBytes, actualBytes: buffer.length }
    );
  }

  const detected = detectedMimeType(buffer);
  if (!detected) {
    throw apiError("PROOF_UNSUPPORTED_MEDIA", "Proof must be JPEG, PNG, or WebP", 415);
  }
  if (declaredMimeType && !allowedMimeTypes.has(declaredMimeType)) {
    throw apiError("PROOF_UNSUPPORTED_MEDIA", "Declared proof MIME type is not supported", 415);
  }
  if (declaredMimeType && declaredMimeType !== detected) {
    throw apiError(
      "PROOF_MIME_MISMATCH",
      "Declared proof MIME type does not match file content",
      400,
      { declared: declaredMimeType, detected }
    );
  }

  return { buffer, mimeType: detected };
}

export function extensionForProofMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".jpg";
  }
}
