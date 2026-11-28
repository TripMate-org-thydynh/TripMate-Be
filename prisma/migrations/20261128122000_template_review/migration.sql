ALTER TABLE "itinerary_templates"
  ADD COLUMN IF NOT EXISTS "review_status" TEXT NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN IF NOT EXISTS "is_editorial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "budget_from" INTEGER,
  ADD COLUMN IF NOT EXISTS "budget_to" INTEGER;
UPDATE "itinerary_templates" SET "review_status" = 'APPROVED'
  WHERE "is_public" = true AND "review_status" = 'PRIVATE';
CREATE INDEX IF NOT EXISTS "itinerary_templates_review_status_deleted_at_idx" ON "itinerary_templates"("review_status", "deleted_at");
