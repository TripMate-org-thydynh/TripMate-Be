/**
 * E2E cho webhook thanh toán.
 *
 * Trọng tâm là ca **sai chữ ký phải bị từ chối**. Bản trước đọc
 * `MOMO_SECRET_KEY` / `ZALOPAY_KEY2` ra rồi không dùng, nên bất kỳ ai biết
 * đường dẫn cũng gửi được `resultCode: 0` và nhận gói miễn phí.
 *
 *   node test/e2e/webhook-e2e.mjs
 */
import { createHmac } from 'crypto';
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

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const MOMO_SECRET = process.env.MOMO_SECRET_KEY;
const ZALO_KEY2 = process.env.ZALOPAY_KEY2;

function momoSignature(p) {
  const raw =
    `accessKey=${process.env.MOMO_ACCESS_KEY ?? ''}` +
    `&amount=${p.amount ?? ''}` +
    `&extraData=${p.extraData ?? ''}` +
    `&message=${p.message ?? ''}` +
    `&orderId=${p.orderId ?? ''}` +
    `&orderInfo=${p.orderInfo ?? ''}` +
    `&orderType=${p.orderType ?? ''}` +
    `&partnerCode=${p.partnerCode ?? ''}` +
    `&payType=${p.payType ?? ''}` +
    `&requestId=${p.requestId ?? ''}` +
    `&responseTime=${p.responseTime ?? ''}` +
    `&resultCode=${p.resultCode ?? ''}` +
    `&transId=${p.transId ?? ''}`;
  return createHmac('sha256', MOMO_SECRET).update(raw).digest('hex');
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { username: 'demo_tripmate' },
    select: { id: true },
  });
  if (!user) throw new Error('Không tìm thấy demo_tripmate');
  await prisma.squadSeat.deleteMany({ where: { subscription: { userId: user.id } } });
  await prisma.subscription.deleteMany({ where: { userId: user.id } });

  console.log('user:', user.id);

  console.log('\n— Momo: sai chữ ký —');
  const orderId = `tmsub.${user.id}.PLUS.1.${Date.now()}`;
  const basePayload = {
    partnerCode: 'MOMO',
    orderId,
    requestId: 'req-' + Date.now(),
    amount: 39000,
    orderInfo: 'TripMate PLUS',
    orderType: 'momo_wallet',
    transId: 'tx-' + Date.now(),
    resultCode: 0,
    message: 'Successful.',
    payType: 'qr',
    responseTime: Date.now(),
    extraData: '',
  };

  const forged = await post('/payment/momo/ipn', {
    ...basePayload,
    signature: 'chu-ky-bia-dat',
  });
  check('Momo: chữ ký sai bị từ chối', forged.status >= 400,
    `status=${forged.status} ${JSON.stringify(forged.json)}`);

  const afterForged = await prisma.subscription.count({ where: { userId: user.id } });
  check('Momo: chữ ký sai KHÔNG cấp quyền', afterForged === 0,
    `số gói = ${afterForged}`);

  if (!MOMO_SECRET) {
    console.log('  BỎ QUA  ca chữ ký đúng — chưa cấu hình MOMO_SECRET_KEY');
  } else {
    console.log('\n— Momo: chữ ký đúng —');
    const good = await post('/payment/momo/ipn', {
      ...basePayload,
      signature: momoSignature(basePayload),
    });
    check('Momo: chữ ký đúng được chấp nhận', good.status === 200,
      `status=${good.status} ${JSON.stringify(good.json)}`);

    const sub = await prisma.subscription.findFirst({ where: { userId: user.id } });
    check('Momo: đã cấp gói PLUS', sub?.plan === 'PLUS', JSON.stringify(sub));
    check('Momo: hạn dùng ở tương lai',
      !!sub && sub.currentPeriodEnd.getTime() > Date.now());

    console.log('\n— Momo: gọi lại webhook lần hai —');
    const again = await post('/payment/momo/ipn', {
      ...basePayload,
      signature: momoSignature(basePayload),
    });
    check('Momo: lần gọi lại vẫn trả 200', again.status === 200);
    const count = await prisma.subscription.count({ where: { userId: user.id } });
    check('Momo: KHÔNG cấp trùng kỳ', count === 1, `số gói = ${count}`);
  }

  console.log('\n— ZaloPay: sai chữ ký —');
  const zaloData = JSON.stringify({
    app_trans_id: 'zp-' + Date.now(),
    zp_trans_id: 'zptx-' + Date.now(),
    embed_data: JSON.stringify({
      orderId: `tmsub.${user.id}.SQUAD.1.${Date.now()}`,
    }),
  });
  const zForged = await post('/payment/zalopay/ipn', {
    data: zaloData,
    mac: 'mac-bia-dat',
  });
  // Chưa cấu hình khoá thì service từ chối bằng 503 — cũng là từ chối hợp lệ,
  // và là hành vi đúng: thà không xử lý còn hơn xử lý mà không kiểm được chữ ký.
  check('ZaloPay: chữ ký sai bị từ chối',
    zForged.json?.return_code === -1 || zForged.status === 503,
    JSON.stringify(zForged.json));

  if (ZALO_KEY2) {
    console.log('\n— ZaloPay: chữ ký đúng —');
    const mac = createHmac('sha256', ZALO_KEY2).update(zaloData).digest('hex');
    const zGood = await post('/payment/zalopay/ipn', { data: zaloData, mac });
    check('ZaloPay: chữ ký đúng được chấp nhận',
      zGood.json?.return_code === 1, JSON.stringify(zGood.json));
  } else {
    console.log('  BỎ QUA  ca chữ ký đúng — chưa cấu hình ZALOPAY_KEY2');
  }

  await prisma.subscription.deleteMany({ where: { userId: user.id } });
  console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
