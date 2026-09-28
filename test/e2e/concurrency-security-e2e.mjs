/**
 * E2E: nhiều người dùng thao tác CÙNG LÚC + các ca tấn công bảo mật.
 *
 * Các bộ khác gọi tuần tự nên không bao giờ lộ race condition. Bộ này bắn
 * song song bằng Promise.all để kiểm những chốt chặn chỉ đúng khi một người
 * bấm một lần: hạn mức thành viên, trừ XP, webhook thanh toán gọi lặp.
 *
 *   node test/e2e/concurrency-security-e2e.mjs
 *
 * Cần server local chạy với MOMO_ACCESS_KEY / MOMO_SECRET_KEY /
 * MOMO_ENDPOINT (stub) và SEPAY_WEBHOOK_TOKEN giống env của test này.
 * User được tạo thẳng trong DB (không qua /auth/register) để khỏi vướng
 * throttle 5 lần/phút; tất cả mang username `e2e_cc_*` và tự dọn ở cuối.
 */
import { createHmac, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const BASE = process.env.API || 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
const stamp = Date.now().toString(36);

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
const section = (t) => console.log(`\n── ${t}`);

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, data: json?.data };
}

const createdUsers = [];
async function makeUser(tag) {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      supabaseId: randomUUID(),
      email: `e2e_cc_${tag}_${stamp}@test.local`,
      name: `CC ${tag}`,
      username: `e2e_cc_${tag}_${stamp}`,
    },
  });
  createdUsers.push(user.id);
  const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
  return { id: user.id, token };
}

const okStatus = (s) => s === 200 || s === 201;

try {
  // ───────────────────────────────────────────────────────────────────────
  section('1. Nhiều người vào chuyến cùng lúc');
  const owner = await makeUser('owner');
  const start = new Date(Date.now() + 7 * 864e5);
  const trip = await call('POST', '/trips', {
    token: owner.token,
    body: {
      name: `CC trip ${stamp}`,
      startDate: start.toISOString(),
      endDate: new Date(start.getTime() + 3 * 864e5).toISOString(),
      currency: 'VND',
    },
  });
  const tripId = trip.data?.id;
  check('Chủ chuyến tạo chuyến', !!tripId, `status=${trip.status} ${JSON.stringify(trip.json)?.slice(0, 200)}`);

  const invite = await call('POST', `/trips/${tripId}/invites`, { token: owner.token, body: {} });
  const code = invite.data?.code;
  check('Tạo link mời', !!code);

  const joiners = await Promise.all(Array.from({ length: 15 }, (_, i) => makeUser(`j${i}`)));
  const joinRes = await Promise.all(
    joiners.map((u) => call('POST', `/trips/join-link/${code}`, { token: u.token })),
  );
  const joinStatuses = joinRes.map((r) => r.status);
  const members = await prisma.tripMember.count({ where: { tripId } });
  check('15 người vào cùng lúc: không lỗi 5xx', joinStatuses.every((s) => s < 500), joinStatuses.join(','));
  check('Hạn mức Free 8 thành viên KHÔNG bị vượt khi vào đồng thời', members <= 8, `số thành viên = ${members}`);
  check('Vẫn nhận đủ tới hạn mức (không từ chối oan)', members === 8, `số thành viên = ${members}`);

  // Cùng một người bấm tham gia 5 lần cùng lúc (mạng lag, bấm liên tục).
  const trip2 = await call('POST', '/trips', {
    token: owner.token,
    body: {
      name: `CC trip2 ${stamp}`,
      startDate: start.toISOString(),
      endDate: new Date(start.getTime() + 864e5).toISOString(),
      currency: 'VND',
    },
  });
  const trip2Id = trip2.data?.id;
  const inv2 = await call('POST', `/trips/${trip2Id}/invites`, { token: owner.token, body: {} });
  const spammer = await makeUser('spam');
  const spam = await Promise.all(
    Array.from({ length: 5 }, () =>
      call('POST', `/trips/join-link/${inv2.data?.code}`, { token: spammer.token }),
    ),
  );
  const spamMember = await prisma.tripMember.count({ where: { tripId: trip2Id, userId: spammer.id } });
  const inv2Row = await prisma.tripInvite.findUnique({ where: { code: inv2.data?.code } });
  check('Bấm tham gia 5 lần cùng lúc: đúng 1 bản ghi thành viên', spamMember === 1, `= ${spamMember}`);
  check('Bấm 5 lần: không có lỗi 5xx', spam.every((r) => r.status < 500), spam.map((r) => r.status).join(','));
  check('Bấm 5 lần: useCount của link chỉ tăng 1', inv2Row?.useCount === 1, `useCount=${inv2Row?.useCount}`);

  // ───────────────────────────────────────────────────────────────────────
  section('2. Nhiều người ghi chi tiêu cùng lúc');
  const memberRows = await prisma.tripMember.findMany({ where: { tripId }, select: { userId: true } });
  const tokenOf = new Map([[owner.id, owner.token], ...joiners.map((u) => [u.id, u.token])]);
  const inTrip = memberRows.map((m) => ({ id: m.userId, token: tokenOf.get(m.userId) }));
  const expRes = await Promise.all(
    inTrip.map((u, i) =>
      call('POST', `/trips/${tripId}/expenses`, {
        token: u.token,
        body: {
          amount: 100000 + i * 1000,
          category: 'FOOD',
          description: `CC ${i}`,
          splitType: 'EQUAL',
          paidById: u.id,
        },
      }),
    ),
  );
  check('Tất cả khoản chi đồng thời đều ghi được', expRes.every((r) => okStatus(r.status)),
    expRes.map((r) => r.status).join(','));
  const expenses = await prisma.expense.findMany({ where: { tripId }, include: { splits: true } });
  check('Số khoản chi khớp số request', expenses.length === inTrip.length, `${expenses.length}/${inTrip.length}`);
  const badSplit = expenses.filter((e) => {
    const s = e.splits.reduce((a, x) => a + Number(x.shareAmount), 0);
    return Math.abs(s - Number(e.amount)) > 1;
  });
  check('Mỗi khoản chi: tổng phần chia = số tiền', badSplit.length === 0, `${badSplit.length} khoản lệch`);
  const net = {};
  for (const e of expenses) {
    net[e.paidById] = (net[e.paidById] ?? 0) + Number(e.amount);
    for (const s of e.splits) net[s.userId] = (net[s.userId] ?? 0) - Number(s.shareAmount);
  }
  const netSum = Object.values(net).reduce((a, b) => a + b, 0);
  check('Tổng số dư cả nhóm = 0 (không sinh/mất tiền)', Math.abs(netSum) < inTrip.length, `tổng = ${netSum}`);
  const bal = await call('GET', `/trips/${tripId}/expenses/balances`, { token: owner.token });
  check('API số dư trả 200 sau ghi đồng thời', bal.status === 200, `status=${bal.status}`);

  // ───────────────────────────────────────────────────────────────────────
  section('3. Thanh toán: webhook gọi lặp song song');
  const payer = await makeUser('payer');
  const order = await call('POST', '/premium/orders', {
    token: payer.token,
    body: { plan: 'PLUS', months: 1, provider: 'MOMO' },
  });
  const orderId = order.data?.orderId;
  check('Tạo đơn MoMo (server tự tính giá)', !!orderId && order.data?.amount === 39000,
    `status=${order.status} ${JSON.stringify(order.json)?.slice(0, 200)}`);

  const momoSign = (p) =>
    createHmac('sha256', process.env.MOMO_SECRET_KEY)
      .update(
        `accessKey=${process.env.MOMO_ACCESS_KEY}&amount=${p.amount}&extraData=${p.extraData}` +
          `&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}` +
          `&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}` +
          `&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}` +
          `&transId=${p.transId}`,
      )
      .digest('hex');
  const ipn = (over = {}) => {
    const p = {
      partnerCode: 'TESTPARTNER', orderId, requestId: 'r' + Date.now(), amount: 39000,
      orderInfo: 'TripMate PLUS', orderType: 'momo_wallet', transId: 'tx-' + stamp,
      resultCode: 0, message: 'Successful.', payType: 'qr', responseTime: Date.now(),
      extraData: '', ...over,
    };
    return { ...p, signature: momoSign(p) };
  };

  // Trả thiếu tiền: dùng một người và một đơn riêng, vì đơn trả thiếu bị
  // đánh FAILED và không dùng lại được.
  const cheapPayer = await makeUser('cheap');
  const cheapOrd = await call('POST', '/premium/orders', {
    token: cheapPayer.token, body: { plan: 'PLUS', months: 1, provider: 'MOMO' },
  });
  await call('POST', '/payment/momo/ipn', {
    body: ipn({ orderId: cheapOrd.data?.orderId, amount: 1000, transId: 'tx-cheap-' + stamp }),
  });
  const afterCheap = await prisma.subscription.count({ where: { userId: cheapPayer.id } });
  check('IPN số tiền 1.000đ (chữ ký hợp lệ) KHÔNG cấp gói', afterCheap === 0, `số gói = ${afterCheap}`);

  const body = ipn();
  const ipnRes = await Promise.all(
    Array.from({ length: 10 }, () => call('POST', '/payment/momo/ipn', { body })),
  );
  check('10 IPN song song: không lỗi 5xx', ipnRes.every((r) => r.status < 500), ipnRes.map((r) => r.status).join(','));
  const subs = await prisma.subscription.findMany({ where: { userId: payer.id } });
  check('10 IPN song song: đúng 1 gói', subs.length === 1, `số gói = ${subs.length}`);
  const days = subs[0] ? (subs[0].currentPeriodEnd - Date.now()) / 864e5 : 0;
  check('Hạn dùng chỉ cộng 1 tháng, không cộng dồn 10 lần', days > 25 && days < 35, `còn ${days.toFixed(1)} ngày`);
  const ord = await prisma.paymentOrder.findUnique({ where: { orderId } });
  check('Đơn chuyển SUCCESS', ord?.status === 'SUCCESS', ord?.status);

  // Đơn của người A không được dùng để cấp gói cho người B.
  const other = await makeUser('other');
  const own = await call('GET', `/premium/orders/${orderId}`, { token: other.token });
  check('Người khác KHÔNG xem được đơn của mình', own.status >= 400 || !own.data?.orderId,
    `status=${own.status}`);

  // Bấm mua 5 lần cùng lúc.
  const buyer = await makeUser('buyer');
  const multi = await Promise.all(
    Array.from({ length: 5 }, () =>
      call('POST', '/premium/orders', { token: buyer.token, body: { plan: 'PLUS', months: 1, provider: 'MOMO' } }),
    ),
  );
  check('5 lần tạo đơn cùng lúc: không lỗi 5xx', multi.every((r) => r.status < 500), multi.map((r) => r.status).join(','));

  // Client gửi số tiền → phải bị bỏ qua.
  const cheapOrder = await call('POST', '/premium/orders', {
    token: buyer.token,
    body: { plan: 'SQUAD', months: 12, provider: 'MOMO', amount: 1000 },
  });
  check('Client tự gửi amount bị bỏ qua (giá do server chốt)',
    cheapOrder.data?.amount === 950000, `amount=${cheapOrder.data?.amount}`);

  // ───────────────────────────────────────────────────────────────────────
  section('4. Tiêu XP đồng thời (double-spend)');
  const spender = await makeUser('xp');
  await prisma.user.update({ where: { id: spender.id }, data: { xpBalance: 250 } });
  const buys = ['stk-laugh', 'stk-roast', 'stk-broke', 'stk-party', 'stk-fire'];
  const cost = { 'stk-laugh': 100, 'stk-roast': 120, 'stk-broke': 150, 'stk-party': 180, 'stk-fire': 200 };
  const buyRes = await Promise.all(
    buys.map((s) => call('POST', '/xp/stickers/purchase', { token: spender.token, body: { stickerId: s } })),
  );
  const okBuys = buys.filter((_, i) => okStatus(buyRes[i].status));
  const spent = okBuys.reduce((a, s) => a + cost[s], 0);
  const after = await prisma.user.findUnique({ where: { id: spender.id }, select: { xpBalance: true } });
  check('Mua 5 sticker cùng lúc với 250 XP: ví không âm', after.xpBalance >= 0, `ví = ${after.xpBalance}`);
  check('Tổng đã tiêu không vượt 250', spent <= 250, `mua được ${okBuys.join(',')} = ${spent}`);
  check('Số dư = 250 − tổng giá đã mua', after.xpBalance === 250 - spent, `ví = ${after.xpBalance}, đã tiêu ${spent}`);
  check('Mua đồng thời: không lỗi 5xx', buyRes.every((r) => r.status < 500), buyRes.map((r) => r.status).join(','));

  const rich = await makeUser('xp2');
  await prisma.user.update({ where: { id: rich.id }, data: { xpBalance: 1000 } });
  const dup = await Promise.all(
    Array.from({ length: 5 }, () =>
      call('POST', '/xp/stickers/purchase', { token: rich.token, body: { stickerId: 'stk-laugh' } }),
    ),
  );
  const richAfter = await prisma.user.findUnique({ where: { id: rich.id }, select: { xpBalance: true } });
  check('Mua CÙNG 1 sticker 5 lần cùng lúc: chỉ trừ 1 lần', richAfter.xpBalance === 900,
    `ví = ${richAfter.xpBalance}, status=${dup.map((r) => r.status).join(',')}`);

  // ───────────────────────────────────────────────────────────────────────
  section('5. Bảo mật: xác thực');
  const fakeSecret = jwt.sign({ sub: owner.id, email: 'x' }, 'khoa-bia-dat-khong-phai-secret-that');
  check('JWT ký bằng secret giả → 401', (await call('GET', '/auth/me', { token: fakeSecret })).status === 401);
  const expired = jwt.sign({ sub: owner.id, email: 'x' }, process.env.JWT_SECRET, { expiresIn: -10 });
  check('JWT hết hạn → 401', (await call('GET', '/auth/me', { token: expired })).status === 401);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url');
  check('JWT alg=none → 401', (await call('GET', '/auth/me', { token: `${header}.${payload}.` })).status === 401);
  const ghost = jwt.sign({ sub: randomUUID(), email: 'x' }, process.env.JWT_SECRET);
  check('JWT hợp lệ nhưng user không tồn tại → 401', (await call('GET', '/auth/me', { token: ghost })).status === 401);
  check('Không gửi token → 401', (await call('GET', '/users/me/trips')).status === 401);

  const locked = await makeUser('locked');
  await prisma.user.update({ where: { id: locked.id }, data: { isLocked: true } });
  check('Tài khoản bị khoá → 401', (await call('GET', '/auth/me', { token: locked.token })).status === 401);

  // Mass assignment: nhét role/xp vào body đăng ký.
  const massUser = `e2e_cc_mass_${stamp}`;
  const mass = await call('POST', '/auth/register-password', {
    body: { username: massUser, password: 'matkhau123', confirmPassword: 'matkhau123',
      role: 'ADMIN', xpBalance: 999999, isLocked: false },
  });
  const massRow = await prisma.user.findUnique({ where: { username: massUser } });
  if (massRow) createdUsers.push(massRow.id);
  check('Đăng ký kèm role=ADMIN bị bỏ qua / từ chối',
    !massRow || (massRow.role === 'USER' && massRow.xpBalance === 0),
    `status=${mass.status} role=${massRow?.role} xp=${massRow?.xpBalance}`);

  // Brute-force mật khẩu phải bị throttle.
  const brute = [];
  for (let i = 0; i < 8; i++) {
    brute.push((await call('POST', '/auth/login-password', {
      body: { username: `e2e_cc_owner_${stamp}`, password: 'sai' + i },
    })).status);
  }
  check('Đoán mật khẩu liên tục bị chặn 429', brute.includes(429), brute.join(','));

  // ───────────────────────────────────────────────────────────────────────
  section('6. Bảo mật: phân quyền (IDOR)');
  const outsider = await makeUser('outsider');
  for (const p of ['', '/expenses', '/expenses/balances', '/itinerary', '/moments', '/chat', '/notes', '/invites']) {
    const r = await call('GET', `/trips/${tripId}${p}`, { token: outsider.token });
    check(`Người ngoài GET /trips/:id${p} bị chặn`, r.status === 403 || r.status === 404, `status=${r.status}`);
  }
  const wExp = await call('POST', `/trips/${tripId}/expenses`, {
    token: outsider.token,
    body: { amount: 1, category: 'FOOD', splitType: 'EQUAL', paidById: outsider.id },
  });
  check('Người ngoài ghi chi tiêu vào chuyến → chặn', wExp.status === 403 || wExp.status === 404, `status=${wExp.status}`);
  const wInv = await call('POST', `/trips/${tripId}/invites`, { token: outsider.token, body: {} });
  check('Người ngoài tạo link mời → chặn', wInv.status === 403 || wInv.status === 404, `status=${wInv.status}`);

  const member = inTrip.find((u) => u.id !== owner.id);
  const delByMember = await call('DELETE', `/trips/${tripId}`, { token: member.token });
  const stillThere = await prisma.trip.findUnique({ where: { id: tripId } });
  check('Thành viên thường KHÔNG xoá được chuyến', delByMember.status >= 400 && !stillThere?.deletedAt,
    `status=${delByMember.status}`);

  const ownerExp = expenses.find((e) => e.paidById === owner.id);
  if (ownerExp) {
    const editOther = await call('PATCH', `/trips/${tripId}/expenses/${ownerExp.id}`, {
      token: member.token, body: { amount: 1 },
    });
    const reread = await prisma.expense.findUnique({ where: { id: ownerExp.id } });
    check('Thành viên KHÔNG sửa được khoản chi của người khác thành 1đ',
      Number(reread.amount) === Number(ownerExp.amount), `status=${editOther.status} amount=${reread.amount}`);
    const delOther = await call('DELETE', `/trips/${tripId}/expenses/${ownerExp.id}`, { token: member.token });
    const reread2 = await prisma.expense.findUnique({ where: { id: ownerExp.id } });
    check('Thành viên KHÔNG xoá được khoản chi của người khác', !!reread2 && !reread2.deletedAt,
      `status=${delOther.status}`);
  }

  // Khoản chi ghi hộ người KHÔNG thuộc chuyến.
  const fakePayer = await call('POST', `/trips/${tripId}/expenses`, {
    token: member.token,
    body: { amount: 500000, category: 'FOOD', splitType: 'EQUAL', paidById: outsider.id },
  });
  check('Ghi khoản chi với người trả ngoài chuyến → chặn', fakePayer.status >= 400, `status=${fakePayer.status}`);

  check('User thường gọi /admin/stats → 403', (await call('GET', '/admin/stats', { token: owner.token })).status === 403);
  check('User thường gọi /admin/observability → 403',
    [403, 404].includes((await call('GET', '/admin/observability/slo', { token: owner.token })).status));

  // ───────────────────────────────────────────────────────────────────────
  section('7. Bảo mật: webhook thanh toán');
  const sepayNoAuth = await call('POST', '/payment/sepay/webhook', {
    body: { transferType: 'in', transferAmount: 39000, content: 'TM000001', id: Date.now() },
  });
  check('SePay webhook không token → từ chối', [400, 401, 403].includes(sepayNoAuth.status),
    `status=${sepayNoAuth.status}`);
  const sepayBad = await call('POST', '/payment/sepay/webhook', {
    headers: { authorization: 'Apikey sai-token' },
    body: { transferType: 'in', transferAmount: 39000, content: 'TM000001', id: Date.now() },
  });
  check('SePay webhook sai token → từ chối', [400, 401, 403].includes(sepayBad.status),
    `status=${sepayBad.status}`);
  const momoForged = await call('POST', '/payment/momo/ipn', { body: { ...ipn(), signature: 'bia' } });
  check('MoMo IPN chữ ký giả → từ chối', momoForged.status >= 400, `status=${momoForged.status}`);

  // Input độc hại không được làm sập server.
  const sqli = await call('GET', `/trips/${encodeURIComponent("' OR 1=1 --")}`, { token: owner.token });
  check('ID kiểu SQL injection → 4xx, không 500', sqli.status >= 400 && sqli.status < 500, `status=${sqli.status}`);
  const huge = await call('POST', `/trips/${tripId}/notes`, {
    token: owner.token, body: { content: 'x'.repeat(5_000_000) },
  });
  check('Body 5MB bị từ chối (413/400), không 500', huge.status === 413 || huge.status === 400, `status=${huge.status}`);
} catch (e) {
  fail++;
  console.log('  FAIL  lỗi ngoài dự kiến —', e.stack);
} finally {
  // Dọn dữ liệu kiểm thử.
  const ids = createdUsers;
  const trips = await prisma.trip.findMany({ where: { createdBy: { in: ids } }, select: { id: true } });
  const tIds = trips.map((t) => t.id);
  for (const [model, where] of [
    ['expenseSplit', { expense: { tripId: { in: tIds } } }],
    ['expense', { tripId: { in: tIds } }],
    ['tripInvite', { tripId: { in: tIds } }],
    ['tripMember', { tripId: { in: tIds } }],
  ]) {
    await prisma[model]?.deleteMany({ where }).catch(() => {});
  }
  await prisma.trip.deleteMany({ where: { id: { in: tIds } } }).catch((e) => console.log('dọn trip:', e.message.slice(0, 120)));
  console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
