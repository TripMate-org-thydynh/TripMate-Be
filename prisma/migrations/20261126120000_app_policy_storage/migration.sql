CREATE TABLE IF NOT EXISTS "system_configs" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" UUID PRIMARY KEY,
  "admin_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "reason" TEXT NOT NULL,
  "details" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "admin_audit_logs_admin_id_idx" ON "admin_audit_logs" ("admin_id");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_target_type_target_id_idx" ON "admin_audit_logs" ("target_type", "target_id");
