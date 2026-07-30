const numberFromEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
};

export const appConfig = {
  currency: "RUB",
  sessionTtlDays: numberFromEnv("SESSION_TTL_DAYS", 30),
  maxProofBytes: numberFromEnv("MAX_PROOF_BYTES", 10 * 1024 * 1024),
  payoutRatio: numberFromEnv("PAYOUT_RATIO", 0.72),
  requestBodyLimitBytes: numberFromEnv("REQUEST_BODY_LIMIT_BYTES", 25 * 1024 * 1024),
  openAiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
  openAiTimeoutMs: numberFromEnv("OPENAI_TIMEOUT_MS", 45_000)
};

if (appConfig.sessionTtlDays <= 0) {
  throw new Error("SESSION_TTL_DAYS must be greater than zero");
}

if (appConfig.maxProofBytes <= 0 || appConfig.maxProofBytes > 10 * 1024 * 1024) {
  throw new Error("MAX_PROOF_BYTES must be between 1 byte and 10MB");
}

if (appConfig.payoutRatio <= 0 || appConfig.payoutRatio >= 1) {
  throw new Error("PAYOUT_RATIO must be between 0 and 1");
}

if (appConfig.openAiTimeoutMs < 5_000 || appConfig.openAiTimeoutMs > 120_000) {
  throw new Error("OPENAI_TIMEOUT_MS must be between 5000 and 120000");
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function corsOrigin() {
  const configured = process.env.CORS_ORIGIN?.trim();
  if (isProduction() && (!configured || configured === "*")) {
    throw new Error("CORS_ORIGIN must contain an explicit origin in production");
  }
  return configured || "*";
}

export function demoLoginEnabled() {
  return !isProduction() && process.env.ENABLE_DEMO_LOGIN !== "false";
}
