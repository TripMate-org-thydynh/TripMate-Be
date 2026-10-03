-- Sticker cá nhân tự làm từ ảnh. Chỉ THÊM: không đụng bảng nào khác.
CREATE TABLE IF NOT EXISTS "custom_stickers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "media_url" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "custom_stickers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "custom_stickers_user_id_deleted_at_idx"
  ON "custom_stickers"("user_id", "deleted_at");

DO $$ BEGIN
  ALTER TABLE "custom_stickers" ADD CONSTRAINT "custom_stickers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
