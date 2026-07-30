-- Executor eligibility and live availability.
CREATE TABLE "ExecutorProfile" (
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "acceptingJobs" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "serviceZones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "shiftStartsAt" TIMESTAMP(3),
    "shiftEndsAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ANDROID',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");
CREATE INDEX "ExecutorProfile_verified_active_acceptingJobs_idx"
  ON "ExecutorProfile"("verified", "active", "acceptingJobs");
CREATE INDEX "ExecutorProfile_lastSeenAt_idx" ON "ExecutorProfile"("lastSeenAt");
CREATE INDEX "PushDevice_userId_enabled_idx" ON "PushDevice"("userId", "enabled");

ALTER TABLE "ExecutorProfile"
  ADD CONSTRAINT "ExecutorProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushDevice"
  ADD CONSTRAINT "PushDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve current production executors, but make the eligibility explicit.
INSERT INTO "ExecutorProfile" (
  "userId", "verified", "active", "acceptingJobs", "online", "lastSeenAt"
)
SELECT "id", true, true, true, false, CURRENT_TIMESTAMP
FROM "User"
WHERE "role" = 'EXECUTOR'
ON CONFLICT ("userId") DO NOTHING;

-- A missing AI result must not be represented as a fake numeric score.
ALTER TABLE "QualityCheck" ALTER COLUMN "score" DROP NOT NULL;
