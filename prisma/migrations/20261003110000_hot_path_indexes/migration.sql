-- Index cho truy vấn nóng (audit cụm I). Chỉ THÊM index.
CREATE INDEX IF NOT EXISTS "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");
CREATE INDEX IF NOT EXISTS "ai_requests_user_id_created_at_idx" ON "ai_requests"("user_id", "created_at");
