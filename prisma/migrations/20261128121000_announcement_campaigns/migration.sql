CREATE TABLE IF NOT EXISTS "announcement_campaigns" (
  "id" UUID PRIMARY KEY,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "image_url" TEXT,
  "cta" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "popup" BOOLEAN NOT NULL DEFAULT false,
  "push" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "campaign_deliveries" (
  "id" UUID PRIMARY KEY,
  "campaign_id" UUID NOT NULL REFERENCES "announcement_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "in_app_at" TIMESTAMP(3),
  "shown_at" TIMESTAMP(3),
  "next_attempt" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "push_accepted" INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_deliveries_campaign_id_user_id_key" ON "campaign_deliveries"("campaign_id", "user_id");
CREATE INDEX IF NOT EXISTS "campaign_deliveries_completed_at_next_attempt_idx" ON "campaign_deliveries"("completed_at", "next_attempt");
CREATE INDEX IF NOT EXISTS "campaign_deliveries_user_id_shown_at_idx" ON "campaign_deliveries"("user_id", "shown_at");
