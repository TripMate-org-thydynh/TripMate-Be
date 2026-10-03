#!/usr/bin/env bash
# Biến môi trường cho e2e. `source` file này trước khi chạy server/test.
#
# Chỉ ghi đè những gì phải khác production; phần còn lại (GOOGLE_CLIENT_ID,
# GEMINI_API_KEY...) vẫn đọc từ .env. dotenv không ghi đè biến đã export, nên
# các giá trị dưới đây luôn thắng.
export DATABASE_URL="postgresql://tripmate:tripmate_test@localhost:5433/tripmate_test"
export DIRECT_URL="$DATABASE_URL"
export REDIS_URL="redis://localhost:6380"
export PORT=3000
export PUBLIC_API_URL="http://localhost:3000"
# Tin 1 lớp proxy để bộ test giả lập IP client qua X-Forwarded-For (giống Render).
export TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-1}"

# Khoá thanh toán GIẢ, đi cùng test/e2e/stub-gateway.mjs.
export MOMO_PARTNER_CODE=TESTPARTNER MOMO_ACCESS_KEY=testaccess MOMO_SECRET_KEY=testsecret
export MOMO_ENDPOINT=http://localhost:4499/create
export ZALOPAY_APP_ID=2553 ZALOPAY_KEY1=testkey1 ZALOPAY_KEY2=testkey2
export ZALOPAY_ENDPOINT=http://localhost:4499/create
export SEPAY_WEBHOOK_TOKEN=test_sepay_token
export SEPAY_ACCOUNT_NUMBER=0000000000 SEPAY_BANK_CODE=MB SEPAY_ACCOUNT_NAME=TEST

# Chốt an toàn: từ chối chạy nếu vì lý do nào đó DATABASE_URL không phải local.
case "$DATABASE_URL" in
  *@localhost:*|*@127.0.0.1:*) ;;
  *) echo "DATABASE_URL không phải database local — dừng để khỏi ghi vào production" >&2; exit 1 ;;
esac
