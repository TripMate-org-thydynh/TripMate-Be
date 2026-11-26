CREATE TABLE IF NOT EXISTS "request_metrics" (
  "id" UUID PRIMARY KEY,
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "route" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "status_class" INTEGER NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "sum_latency_ms" BIGINT NOT NULL DEFAULT 0,
  "max_latency_ms" INTEGER NOT NULL DEFAULT 0,
  "le_50" INTEGER NOT NULL DEFAULT 0,
  "le_100" INTEGER NOT NULL DEFAULT 0,
  "le_250" INTEGER NOT NULL DEFAULT 0,
  "le_500" INTEGER NOT NULL DEFAULT 0,
  "le_1000" INTEGER NOT NULL DEFAULT 0,
  "le_2500" INTEGER NOT NULL DEFAULT 0,
  "le_5000" INTEGER NOT NULL DEFAULT 0,
  "le_inf" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "request_metrics_bucket_start_route_method_status_class_key"
  ON "request_metrics" ("bucket_start", "route", "method", "status_class");
CREATE INDEX IF NOT EXISTS "request_metrics_bucket_start_idx" ON "request_metrics" ("bucket_start");

CREATE TABLE IF NOT EXISTS "slo_targets" (
  "id" UUID PRIMARY KEY,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sli_type" TEXT NOT NULL,
  "objective" DECIMAL(6,3) NOT NULL,
  "window_days" INTEGER NOT NULL DEFAULT 30,
  "latency_threshold_ms" INTEGER,
  "route_prefix" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "slo_targets_key_key" ON "slo_targets" ("key");

CREATE TABLE IF NOT EXISTS "request_failures" (
  "id" UUID PRIMARY KEY,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "route" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "status_code" INTEGER NOT NULL,
  "duration_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "request_failures_occurred_at_idx" ON "request_failures" ("occurred_at");
CREATE INDEX IF NOT EXISTS "request_failures_route_method_occurred_at_idx"
  ON "request_failures" ("route", "method", "occurred_at");
