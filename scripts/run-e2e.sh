#!/usr/bin/env bash
# Cháº¡y cĂ¡c bá»™ e2e trĂªn háº¡ táº§ng test (npm run test:db:up trÆ°á»›c).
#
# Má»—i bá»™ cháº¡y trĂªn má»™t tiáº¿n trĂ¬nh server Má»I: vĂ i bá»™ Ä‘á»•i tráº¡ng thĂ¡i toĂ n cá»¥c
# (háº¡n má»©c, throttle) nĂªn cháº¡y ná»‘i tiáº¿p trĂªn cĂ¹ng tiáº¿n trĂ¬nh sáº½ áº£nh hÆ°á»Ÿng nhau.
#
#   npm run test:e2e:all
#   SUITES="webhook-e2e sepay-e2e" npm run test:e2e:all
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/test-env.sh

LOG_DIR="${LOG_DIR:-test/e2e/.logs}"
mkdir -p "$LOG_DIR"
SUITES="${SUITES:-api-e2e webhook-e2e sepay-e2e payment-e2e checkout-e2e entitlement-e2e gating-e2e trial-e2e referral-promo-e2e concurrency-security-e2e account-delete-e2e ghost-e2e reports-e2e custom-sticker-e2e}"

npm run build >/dev/null || { echo "build lá»—i"; exit 1; }

node test/e2e/stub-gateway.mjs >"$LOG_DIR/stub.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT

failed=()
for suite in $SUITES; do
  node dist/main >"$LOG_DIR/server-$suite.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null localhost:3000/api/v1/health && break
    sleep 1
  done
  if node "test/e2e/$suite.mjs" >"$LOG_DIR/$suite.log" 2>&1; then
    echo "PASS  $suite  ($(grep -aiE 'pass' "$LOG_DIR/$suite.log" | tail -1 | tr -s ' '))"
  else
    echo "FAIL  $suite  â€” xem $LOG_DIR/$suite.log"
    grep -a "FAIL" "$LOG_DIR/$suite.log" | head -10
    failed+=("$suite")
  fi
  kill $SRV 2>/dev/null
  wait $SRV 2>/dev/null
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Há»ng: ${failed[*]}"
  exit 1
fi
echo "Táº¥t cáº£ bá»™ e2e Ä‘á»u qua."
