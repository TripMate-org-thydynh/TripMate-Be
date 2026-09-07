/**
 * E2E cho mã giới thiệu và mã giảm giá.
 *
 * Ba thứ bản trước không làm được:
 *   1. `submitReferral` trả `success: true` cho MỌI chuỗi, tặng 500 XP trên
 *      giấy mà không ghi vào đâu.
 *   2. Chống tự giới thiệu chỉ so với đúng chuỗi literal `'SELF'`.
 *   3. `validatePromoCode` trả về `discount` rồi **không nơi nào dùng tới** —
 *      người dùng thấy "giảm 50%" và trả nguyên giá.
 *
 * Cần seed mã giảm giá trước: `npm run seed:promo`
 *
 *   npm run test:referral
 */
import { PrismaClient } from '@prisma/client';

const B = process.env.API || 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
const stamp = Date.now();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(B + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, data: json?.data };
}

async function newUser(tag) {
  const r = await call('POST', '/auth/register-password', {
    body: {
      username: `rp_${tag}_${stamp}`,
      password: 'matkhau123',
      confirmPassword: 'matkhau123',
    },
  });
  return { token: r.data.token, id: r.data.user.id };
}

const xpOf = async (id) =>
  (await prisma.user.findUnique({ where: { id }, select: { xpBalance: true } }))
    ?.xpBalance ?? 0;

console.log('── Mã giới thiệu ───────────────────────────────────────────');

const alice = await newUser('alice');
const bob = await newUser('bob');

const mine = await call('GET', '/premium/referrals/me', { token: alice.token });
const code = mine.data?.code;
check('Sinh được mã giới thiệu', /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code ?? ''), `code=${code}`);
check('Người mới chưa mời được ai', mine.data?.count === 0, `count=${mine.data?.count}`);

const again = await call('GET', '/premium/referrals/me', { token: alice.token });
check('Gọi lại trả về CÙNG một mã, không sinh mã mới', again.data?.code === code);

// Mã không tồn tại: bản trước nhận mọi chuỗi.
const bogus = await call('POST', '/premium/referrals', {
  token: bob.token,
  body: { code: 'ZZZZZZ' },
});
check('Mã không tồn tại bị từ chối', bogus.json?.code === 'CODE_NOT_FOUND', `status=${bogus.status} ${JSON.stringify(bogus.json)?.slice(0, 80)}`);

// Tự giới thiệu mình — kiểm theo CHỦ SỞ HỮU mã, không theo chuỗi 'SELF'.
const self = await call('POST', '/premium/referrals', {
  token: alice.token,
  body: { code },
});
check('Tự nhập mã của chính mình bị chặn', self.json?.code === 'SELF_REFERRAL', JSON.stringify(self.json)?.slice(0, 90));

const aliceBefore = await xpOf(alice.id);
const bobBefore = await xpOf(bob.id);

const ok = await call('POST', '/premium/referrals', {
  token: bob.token,
  body: { code: code.toLowerCase() },
});
check('Nhập mã hợp lệ thành công (không phân biệt hoa thường)', ok.data?.success === true, JSON.stringify(ok.json)?.slice(0, 100));

const aliceAfter = await xpOf(alice.id);
const bobAfter = await xpOf(bob.id);
check('Người MỜI được cộng XP thật vào số dư', aliceAfter > aliceBefore, `${aliceBefore} → ${aliceAfter}`);
check('Người ĐƯỢC MỜI được cộng XP thật vào số dư', bobAfter > bobBefore, `${bobBefore} → ${bobAfter}`);

const ledger = await prisma.xpLedger.findMany({
  where: { userId: bob.id, reason: 'REFERRAL_RECEIVED' },
});
check('Có ghi vào sổ cái XP, không chỉ là số trong response', ledger.length === 1, `n=${ledger.length}`);

const stats = await call('GET', '/premium/referrals/me', { token: alice.token });
check('Số bạn đã mời là số THẬT', stats.data?.count === 1, `count=${stats.data?.count}`);
check('Danh sách là người thật, không phải tên bịa', stats.data?.invited?.[0]?.name?.includes(`rp_bob_${stamp}`), JSON.stringify(stats.data?.invited?.[0])?.slice(0, 80));

// Nhập lần hai
const twice = await call('POST', '/premium/referrals', {
  token: bob.token,
  body: { code },
});
check('Mỗi người chỉ được giới thiệu một lần', twice.json?.code === 'ALREADY_REFERRED', JSON.stringify(twice.json)?.slice(0, 90));

// Giới thiệu qua lại: bob mời lại alice
const bobCode = (await call('GET', '/premium/referrals/me', { token: bob.token })).data?.code;
const reciprocal = await call('POST', '/premium/referrals', {
  token: alice.token,
  body: { code: bobCode },
});
check('Giới thiệu qua lại A↔B bị chặn', reciprocal.json?.code === 'RECIPROCAL_REFERRAL', JSON.stringify(reciprocal.json)?.slice(0, 90));

const st = await call('GET', '/premium/referrals/status', { token: bob.token });
check('Trạng thái nói rõ đã được ai mời', st.data?.canSubmit === false && st.data?.referredBy != null, JSON.stringify(st.data)?.slice(0, 100));

console.log('\n── Mã giảm giá ─────────────────────────────────────────────');

const carol = await newUser('carol');
const H = { token: carol.token };

const list = await call('GET', '/premium/promo-codes', H);
check('Liệt kê được các mã đang chạy', Array.isArray(list.data) && list.data.length >= 3, `n=${list.data?.length}`);

const bad = await call('POST', '/premium/promo-codes/validate', {
  ...H,
  body: { code: 'KHONGCO' },
});
check('Mã không tồn tại bị từ chối', bad.json?.code === 'PROMO_NOT_FOUND');

// ELITESQUAD giảm 50%. PLUS 1 tháng = 39.000 → giảm 20.000 (làm tròn 1.000).
const v = await call('POST', '/premium/promo-codes/validate', {
  ...H,
  body: { code: 'elitesquad', plan: 'PLUS', months: 1 },
});
check('Trả về SỐ TIỀN được giảm, không chỉ tỉ lệ', v.data?.discount === 20000 && v.data?.total === 19000, JSON.stringify(v.data));

// DALATCHILL chỉ áp cho SQUAD.
const wrongPlan = await call('POST', '/premium/promo-codes/validate', {
  ...H,
  body: { code: 'DALATCHILL', plan: 'PLUS', months: 1 },
});
check('Mã giới hạn theo gói bị từ chối đúng chỗ', wrongPlan.json?.code === 'PROMO_WRONG_PLAN', JSON.stringify(wrongPlan.json)?.slice(0, 90));

// Áp vào đơn thật — đây là thứ bản trước hoàn toàn không làm.
const order = await call('POST', '/premium/orders', {
  ...H,
  body: { plan: 'PLUS', months: 1, provider: 'MOMO', promoCode: 'ELITESQUAD' },
});
check('Đơn được tạo với giá ĐÃ GIẢM', order.data?.amount === 19000, `amount=${order.data?.amount} base=${order.data?.baseAmount}`);
check('Đơn ghi lại giá gốc và mức giảm', order.data?.baseAmount === 39000 && order.data?.discount === 20000, JSON.stringify(order.data)?.slice(0, 130));

const row = await prisma.paymentOrder.findUnique({ where: { orderId: order.data.orderId } });
check('DB lưu đúng số tiền phải trả', Number(row?.amount) === 19000 && row?.promoCode === 'ELITESQUAD', `amount=${row?.amount} code=${row?.promoCode}`);

// Chưa thanh toán thì chưa tính lượt.
const usedBefore = await prisma.promoRedemption.count({
  where: { promoCode: { code: 'ELITESQUAD' } },
});
check('Đơn chưa trả tiền KHÔNG đốt suất của mã', usedBefore === 0, `n=${usedBefore}`);

// Mã hỏng phải làm hỏng cả đơn, không âm thầm thu đủ tiền.
const badOrder = await call('POST', '/premium/orders', {
  ...H,
  body: { plan: 'PLUS', months: 1, provider: 'MOMO', promoCode: 'KHONGCO' },
});
check('Mã hỏng làm hỏng đơn, không thu đủ giá', badOrder.json?.code === 'PROMO_NOT_FOUND', `status=${badOrder.status}`);

// Client tự khai mức giảm.
const cheat = await call('POST', '/premium/orders', {
  ...H,
  body: {
    plan: 'PLUS',
    months: 1,
    provider: 'MOMO',
    amount: 1000,
    discount: 38000,
    total: 1000,
  },
});
check('Client tự khai mức giảm không có tác dụng', cheat.data?.amount === 39000, `amount=${cheat.data?.amount}`);

console.log('\n── Chợ nhà sáng tạo ────────────────────────────────────────');

const cr = await call('GET', '/premium/creator-revenue', H);
check('Nói rõ chợ chưa mở, không bịa doanh thu', cr.data?.marketplaceOpen === false, JSON.stringify(cr.data)?.slice(0, 120));
check('Không còn con số tiền bịa', cr.data?.totalSalesRevenue === undefined && cr.data?.payoutPending === undefined);
check('Trả về số liệu thật của cửa hàng XP', cr.data?.currency === 'XP' && cr.data?.stickersOwned === 0, JSON.stringify(cr.data)?.slice(0, 110));

console.log(`\n${pass} pass, ${fail} fail`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
