/**
 * E2E kiểm tra API Khởi tạo Thanh toán (Checkout).
 *
 * Kiểm tra các luồng:
 * 1. Checkout MoMo (Gói PLUS 1 tháng: 39.000đ)
 * 2. Checkout ZaloPay (Gói PLUS 1 năm: 299.000đ)
 * 3. Checkout Squad Pass (Gói SQUAD 1 tháng: 99.000đ)
 * 4. Kiểm tra mã đơn tmsub.<userId>.<plan>.<months>.<timestamp>
 * 5. Kiểm tra validate từ chối phương thức / gói không hợp lệ.
 *
 *   node test/e2e/checkout-e2e.mjs
 */
import { PrismaClient } from '@prisma/client';

const BASE = process.env.API || 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, data: json?.data ?? json };
}

async function login() {
  const r = await call('POST', '/auth/login-password', {
    body: { username: 'demo_tripmate', password: 'matkhau123' },
  });
  if (!r.data?.token) throw new Error('Không đăng nhập được: ' + r.status);
  return { token: r.data.token, userId: r.data.user.id };
}

async function main() {
  const { token, userId } = await login();
  console.log('user:', userId);

  console.log('\n— Khởi tạo thanh toán MoMo —');
  const momoRes = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'MOMO' },
  });

  check('MoMo: HTTP 200/201', momoRes.status === 200 || momoRes.status === 201, `status=${momoRes.status}`);
  check('MoMo: provider = MOMO', momoRes.data?.provider === 'MOMO', JSON.stringify(momoRes.data));
  check('MoMo: amount = 39.000đ', momoRes.data?.amount === 39000, `amount=${momoRes.data?.amount}`);
  check(
    'MoMo: orderId chuẩn tmsub.<userId>.PLUS.1.*',
    momoRes.data?.orderId?.startsWith(`tmsub.${userId}.PLUS.1.`),
    `orderId=${momoRes.data?.orderId}`,
  );
  check(
    'MoMo: trả về payUrl hợp lệ',
    typeof momoRes.data?.payUrl === 'string' && momoRes.data.payUrl.includes('test-payment.momo.vn'),
    `payUrl=${momoRes.data?.payUrl}`,
  );

  console.log('\n— Khởi tạo thanh toán ZaloPay —');
  const zaloRes = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 12, paymentMethod: 'ZALOPAY' },
  });

  check('ZaloPay: HTTP 200/201', zaloRes.status === 200 || zaloRes.status === 201, `status=${zaloRes.status}`);
  check('ZaloPay: provider = ZALOPAY', zaloRes.data?.provider === 'ZALOPAY', JSON.stringify(zaloRes.data));
  check('ZaloPay: amount gói năm = 299.000đ', zaloRes.data?.amount === 299000, `amount=${zaloRes.data?.amount}`);
  check(
    'ZaloPay: orderId chuẩn tmsub.<userId>.PLUS.12.*',
    zaloRes.data?.orderId?.startsWith(`tmsub.${userId}.PLUS.12.`),
    `orderId=${zaloRes.data?.orderId}`,
  );
  check(
    'ZaloPay: trả về payUrl hợp lệ',
    typeof zaloRes.data?.payUrl === 'string' && zaloRes.data.payUrl.includes('zalopay.vn'),
    `payUrl=${zaloRes.data?.payUrl}`,
  );

  console.log('\n— Khởi tạo Squad Pass MoMo —');
  const squadRes = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'SQUAD', months: 1, paymentMethod: 'MOMO' },
  });

  check('Squad Pass: amount = 99.000đ', squadRes.data?.amount === 99000, `amount=${squadRes.data?.amount}`);
  check(
    'Squad Pass: orderId chuẩn tmsub.<userId>.SQUAD.1.*',
    squadRes.data?.orderId?.startsWith(`tmsub.${userId}.SQUAD.1.`),
    `orderId=${squadRes.data?.orderId}`,
  );

  console.log('\n— Kiểm tra Validation & Từ chối —');
  const invalidMethod = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'BITCOIN' },
  });
  check('Từ chối phương thức thanh toán lạ (400)', invalidMethod.status === 400, `status=${invalidMethod.status}`);

  const invalidPlan = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'SUPER_VIP', months: 1, paymentMethod: 'MOMO' },
  });
  check('Từ chối gói không tồn tại (400)', invalidPlan.status === 400, `status=${invalidPlan.status}`);

  console.log(`\nKết quả Checkout E2E: ${pass} pass, ${fail} fail`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('LỖI:', e);
  await prisma.$disconnect();
  process.exit(1);
});
