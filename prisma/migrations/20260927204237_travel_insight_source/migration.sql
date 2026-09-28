-- Viết tay chứ không dùng `prisma migrate diff`: Prisma không biết chỉ mục
-- HNSW (tạo bằng SQL thô vì kiểu vector không có trong schema language) nên
-- bản diff tự sinh có câu DROP INDEX ai_embeddings_embedding_hnsw — chạy vào
-- là mất chỉ mục, mọi truy vấn tìm theo nghĩa quay về quét tuần tự.

ALTER TYPE "EmbeddingSource" ADD VALUE IF NOT EXISTS 'TRAVEL_INSIGHT';

-- Nguồn ngoài (video KOL) không thuộc mẫu nào.
ALTER TABLE "ai_embeddings" ALTER COLUMN "template_id" DROP NOT NULL;

-- Ghi nguồn: bắt buộc với nội dung rút từ video của người khác.
ALTER TABLE "ai_embeddings" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "ai_embeddings" ADD COLUMN IF NOT EXISTS "source_author" TEXT;
