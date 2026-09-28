/**
 * E2E test suite: SePay VietQR Payment Integration & Webhook Fulfillment
 *
 * Run:
 *   node test/e2e/sepay-e2e.mjs
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

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
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
  console.log('SePay E2E Test - Running for user:', userId);
  // Bắt đầu từ bản Free: lần chạy trước để lại gói SQUAD thì bước "lên PLUS"
  // không bao giờ thấy PLUS (entitlement trả gói cao nhất).
  await prisma.squadSeat.deleteMany({ where: { subscription: { userId } } });
  await prisma.subscription.deleteMany({ where: { userId } });

  // Mã giao dịch SePay phải khác nhau giữa các lần chạy: server nhớ mã đã dùng.
  const RUN = Date.now() * 10;
  const SEPAY_TOKEN = process.env.SEPAY_WEBHOOK_TOKEN || 'MY_SEPAY_SECRET_0406';

  console.log('\n--- 1. Khởi tạo thanh toán VietQR (SePay) ---');
  const checkoutRes = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'SEPAY' },
  });

  check('Checkout HTTP 200/201', checkoutRes.status === 200 || checkoutRes.status === 201);
  const checkoutData = checkoutRes.data;
  check('Provider là SEPAY', checkoutData?.provider === 'SEPAY');
  check('Sinh mã đơn ngắn TM...', /^TM[2-9A-HJ-NP-Z0-9]{6}$/.test(checkoutData?.orderCode || ''));
  check('Số tiền gói PLUS 1 tháng là 39.000đ', checkoutData?.amount === 39000);
  check('Có qrUrl SePay', typeof checkoutData?.qrUrl === 'string' && checkoutData.qrUrl.includes('qr.sepay.vn/img'));
  check('Có vietqrUrl chuẩn VietQR.app', typeof checkoutData?.vietqrUrl === 'string' && checkoutData.vietqrUrl.includes('vietqr.app/img'));
  check('Có payUrl SePay Gateway', typeof checkoutData?.payUrl === 'string' && checkoutData.payUrl.includes('qr.sepay.vn/gateway'));
  // Tài khoản nhận lấy từ cấu hình server, không còn giá trị mặc định cứng.
  check('bankInfo khớp tài khoản cấu hình trong SEPAY_ACCOUNT_*',
    Boolean(checkoutData?.bankInfo?.accountNumber === process.env.SEPAY_ACCOUNT_NUMBER &&
            checkoutData?.bankInfo?.accountName === process.env.SEPAY_ACCOUNT_NAME &&
            checkoutData?.bankInfo?.transferContent === checkoutData?.orderCode));

  const orderCode1 = checkoutData?.orderCode;

  // Kiểm tra PaymentTransaction trong DB
  const pendingTx = await prisma.paymentOrder.findUnique({ where: { orderId: orderCode1 } });
  check('Đã lưu đơn PENDING trong bảng PaymentOrder', pendingTx?.status === 'PENDING');

  console.log('\n--- 2. Webhook SePay: Từ chối khi sai Token ---');
  const badAuthRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: 'Apikey wrong_secret_token' },
    body: {
      id: RUN + 1,
      gateway: 'MBBank',
      code: orderCode1,
      transferType: 'in',
      transferAmount: 39000,
    },
  });
  check('Webhook từ chối token sai (HTTP 400)', badAuthRes.status === 400);

  console.log('\n--- 3. Webhook SePay: Từ chối khi chuyển thiếu tiền ---');
  const underpaidRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: {
      id: RUN + 2,
      gateway: 'MBBank',
      code: orderCode1,
      transferType: 'in',
      transferAmount: 10000, // Thiếu tiền (39.000đ mà chuyển 10.000đ)
    },
  });
  check('Webhook từ chối khi thiếu tiền', underpaidRes.data?.success === false);
  const failedTx = await prisma.paymentOrder.findUnique({ where: { orderId: orderCode1 } });
  // Chuyển khoản thiếu được giữ PENDING có chủ đích: chuyển bù đúng số vẫn
  // hoàn tất được chính đơn đó (xem `fulfill`, allowOverpay).
  check('Chuyển thiếu tiền: đơn giữ PENDING, không cấp gói', failedTx?.status === 'PENDING');

  console.log('\n--- 4. Webhook SePay: Kích hoạt thành công gói PLUS ---');
  // Tạo đơn mới để thanh toán thành công
  const checkoutRes2 = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'SEPAY' },
  });
  const orderCode2 = checkoutRes2.data?.orderCode;

  const sepayTxId = RUN + 3;
  const validWebhookRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: {
      id: sepayTxId,
      gateway: 'MBBank',
      transactionDate: '2026-09-07 12:15:00',
      accountNumber: process.env.SEPAY_ACCOUNT_NUMBER,
      code: orderCode2,
      content: `Thanh toan don hang ${orderCode2} tai tripmate`,
      transferType: 'in',
      transferAmount: 39000,
      referenceCode: 'FT260907123456',
    },
  });

  check('Webhook trả về success: true', validWebhookRes.data?.success === true);

  const successTx = await prisma.paymentOrder.findUnique({ where: { orderId: orderCode2 } });
  check('PaymentOrder cập nhật trạng thái SUCCESS', successTx?.status === 'SUCCESS');

  // Kiểm tra quyền sở hữu gói
  const entRes = await call('GET', '/premium/entitlement', { token });
  check('Quyền người dùng đã được kích hoạt thành PLUS', entRes.data?.plan === 'PLUS');

  // Kiểm tra endpoint kiểm tra trạng thái đơn hàng thời gian thực cho App
  const statusRes = await call('GET', `/premium/order-status/${orderCode2}`, { token });
  check('API order-status xác nhận isPaid = true cho đơn đã nhận Webhook', statusRes.data?.isPaid === true && statusRes.data?.status === 'SUCCESS');

  console.log('\n--- 5. Chống replay Webhook (Idempotency) ---');
  const duplicateWebhookRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: {
      id: sepayTxId,
      gateway: 'MBBank',
      code: orderCode2,
      content: `Thanh toan don hang ${orderCode2} tai tripmate`,
      transferType: 'in',
      transferAmount: 39000,
    },
  });
  check('Webhook gọi lại xử lý an toàn (idempotent)', duplicateWebhookRes.data?.success === true);

  console.log('\n--- 6. Bắt mã đơn từ trường nội dung (content regex) cho Squad Pass ---');
  const checkoutSquad = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'SQUAD', months: 1, paymentMethod: 'SEPAY' },
  });
  const orderCodeSquad = checkoutSquad.data?.orderCode;
  check('Tạo đơn SQUAD thành công 99.000đ', checkoutSquad.data?.amount === 99000);

  const sepayTxSquad = RUN + 4;
  const contentOnlyRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: {
      id: sepayTxSquad,
      gateway: 'MBBank',
      code: null, // SePay không parse sẵn code
      content: `MBVCB.789123. ${orderCodeSquad} NGUYEN VAN A CHUYEN TIEN`,
      transferType: 'in',
      transferAmount: 99000,
      referenceCode: 'FT260907999888',
    },
  });

  check('Regex bắt được mã TM... từ chuỗi content ngân hàng', contentOnlyRes.data?.success === true);
  const entSquad = await call('GET', '/premium/entitlement', { token });
  check('Cấp thành công gói SQUAD từ webhook content regex', entSquad.data?.plan === 'SQUAD');

  // Phát lại mã giao dịch đã dùng cho một đơn MỚI: đơn mới không được báo "đã trả".
  const replayOrder = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'SEPAY' },
  });
  await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: { id: sepayTxId, code: replayOrder.data?.orderCode, transferType: 'in', transferAmount: 39000 },
  });
  const replayRow = await prisma.paymentOrder.findUnique({ where: { orderId: replayOrder.data?.orderCode } });
  check('Phát lại mã giao dịch cũ cho đơn mới: đơn mới vẫn PENDING', replayRow?.status === 'PENDING', replayRow?.status);

  console.log('\n--- 7. Bỏ qua giao dịch tiền ra (transferType: out) ---');
  const outRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Apikey ${SEPAY_TOKEN}` },
    body: {
      id: RUN + 5,
      transferType: 'out',
      transferAmount: 50000,
      content: 'Chuyen tien tra tien an',
    },
  });
  check('Bỏ qua giao dịch chuyển tiền ra an toàn', outRes.data?.success === true && outRes.data?.message?.includes('outbound'));

  console.log('\n--- 8. Hỗ trợ Header x-api-key & Bearer Token ---');
  // Test x-api-key
  const checkoutApiKey = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'SEPAY' },
  });
  const codeApiKey = checkoutApiKey.data?.orderCode;

  const apiKeyRes = await call('POST', '/payment/sepay/webhook', {
    headers: { 'x-api-key': SEPAY_TOKEN },
    body: {
      id: RUN + 6,
      code: codeApiKey,
      transferType: 'in',
      transferAmount: 39000,
    },
  });
  check('Xác thực thành công qua header x-api-key', apiKeyRes.data?.success === true);

  // Test Bearer token
  const checkoutBearer = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 1, paymentMethod: 'SEPAY' },
  });
  const codeBearer = checkoutBearer.data?.orderCode;

  const bearerRes = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: `Bearer ${SEPAY_TOKEN}` },
    body: {
      id: RUN + 7,
      code: codeBearer,
      transferType: 'in',
      transferAmount: 39000,
    },
  });
  check('Xác thực thành công qua header Bearer', bearerRes.data?.success === true);

  console.log('\n--- 9. Gói năm PLUS (12 tháng = 299.000đ) ---');
  const checkoutYear = await call('POST', '/premium/checkout', {
    token,
    body: { plan: 'PLUS', months: 12, paymentMethod: 'SEPAY' },
  });
  check('Tạo đơn gói năm PLUS thành công 374.000đ (giảm 20%)', checkoutYear.data?.amount === 374000);

  console.log('\n--- 10. Kiểm tra Lịch sử thanh toán (Billing History) ---');
  const historyRes = await call('GET', '/premium/billing-history', { token });
  const hasSepayTx = historyRes.data?.history?.some(
    (h) => h.method === 'SEPAY' && h.status === 'SUCCESS',
  );
  check('Lịch sử thanh toán ghi nhận giao dịch SePay SUCCESS', Boolean(hasSepayTx));

  console.log('\n========================================');
  console.log(`Kết quả SePay E2E: ${pass} PASS, ${fail} FAIL`);
  console.log('========================================');

  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('Lỗi chạy SePay E2E test:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
