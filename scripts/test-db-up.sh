#!/usr/bin/env bash
# Bật hạ tầng e2e, đẩy schema và seed dữ liệu test. Chạy lại nhiều lần được.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/test-env.sh

docker compose -f docker-compose.test.yml up -d --wait

# pgvector phải có TRƯỚC khi đẩy schema (cột ai_embeddings.embedding).
docker exec tripmate-pg-test psql -U tripmate -d tripmate_test -qc 'CREATE EXTENSION IF NOT EXISTS vector;'

# db push chứ không migrate: thư mục migrations chỉ có vài migration gần đây,
# không dựng được schema từ đầu (dự án vốn quản lý schema bằng db push).
npx prisma db push --skip-generate --accept-data-loss

# Chỉ mục HNSW Prisma không biết tới — thêm tay như migration gốc.
docker exec tripmate-pg-test psql -U tripmate -d tripmate_test -qc \
  'CREATE INDEX IF NOT EXISTS ai_embeddings_embedding_hnsw ON ai_embeddings USING hnsw (embedding vector_cosine_ops);'

node test/e2e/seed-test-db.mjs
echo "Hạ tầng e2e sẵn sàng: Postgres :5433, Redis :6380"
