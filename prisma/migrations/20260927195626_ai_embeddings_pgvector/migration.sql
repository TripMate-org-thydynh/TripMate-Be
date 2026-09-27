-- pgvector: tìm kiếm theo nghĩa cho kho mẫu cộng đồng.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "EmbeddingSource" AS ENUM ('TEMPLATE', 'TEMPLATE_STOP');

-- CreateTable
CREATE TABLE "ai_embeddings" (
    "id" UUID NOT NULL,
    "source" "EmbeddingSource" NOT NULL,
    "source_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_embeddings_template_id_idx" ON "ai_embeddings"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_embeddings_source_source_id_key" ON "ai_embeddings"("source", "source_id");


-- Chỉ mục HNSW cho khoảng cách cosine. Không có nó thì mỗi lần tìm là quét
-- tuần tự toàn bảng — chấp nhận được lúc kho nhỏ, sập khi kho lớn.
CREATE INDEX "ai_embeddings_embedding_hnsw"
  ON "ai_embeddings" USING hnsw ("embedding" vector_cosine_ops);
