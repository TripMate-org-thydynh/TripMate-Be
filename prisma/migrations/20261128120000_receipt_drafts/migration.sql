CREATE TABLE IF NOT EXISTS "receipt_drafts" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "creator_id" UUID NOT NULL,
    "expense_id" UUID REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    "title" TEXT NOT NULL,
    "total" BIGINT NOT NULL,
    "tax" BIGINT NOT NULL DEFAULT 0,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipt_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipt_drafts_expense_id_key" ON "receipt_drafts"("expense_id");
CREATE INDEX IF NOT EXISTS "receipt_drafts_trip_id_created_at_idx" ON "receipt_drafts"("trip_id", "created_at");

CREATE TABLE IF NOT EXISTS "receipt_lines" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL REFERENCES "receipt_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "assigned_by" UUID,
    "assignee_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipt_lines_draft_id_position_key" ON "receipt_lines"("draft_id", "position");
