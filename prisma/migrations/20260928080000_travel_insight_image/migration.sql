-- Viết tay (xem 20260927204237_travel_insight_source): diff tự sinh sẽ DROP
-- chỉ mục HNSW mà Prisma không biết.

-- Link ảnh minh hoạ địa điểm lấy từ bài blog gốc. Chỉ lưu LINK, không tải
-- ảnh về — ảnh vẫn là của trang nguồn, hiển thị kèm source_url.
ALTER TABLE "ai_embeddings" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
