-- Báo cáo nội dung vi phạm (chính sách UGC của Google Play).
-- Chỉ THÊM: không đụng bảng nào khác.
DO $$ BEGIN
  CREATE TYPE "ReportTarget" AS ENUM ('TEMPLATE', 'MOMENT', 'CHAT_MESSAGE', 'USER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'SEXUAL', 'VIOLENCE', 'HATE', 'HARASSMENT', 'ILLEGAL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "content_reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "target_type" "ReportTarget" NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "note" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "content_reports_reporter_id_target_type_target_id_key"
  ON "content_reports"("reporter_id", "target_type", "target_id");
CREATE INDEX IF NOT EXISTS "content_reports_target_type_target_id_idx"
  ON "content_reports"("target_type", "target_id");
CREATE INDEX IF NOT EXISTS "content_reports_status_created_at_idx"
  ON "content_reports"("status", "created_at");

DO $$ BEGIN
  ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_id_fkey"
    FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
