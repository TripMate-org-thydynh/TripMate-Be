/**
 * E2E cho dùng thử 3 ngày và tầng chống lạm dụng.
 *
 * Hai câu hỏi quan trọng nhất:
 *   1. Trial hết hạn thì quyền có tự mất không, **kể cả khi job dọn hạn chưa
 *      chạy**? (Phải có: quyền so với `currentPeriodEnd`, không so với cột
 *      `status`.)
 *   2. Client có sửa được thời hạn hay gói bằng cách gửi thêm trường không?
 *
 *   npm run test:trial
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
  const username = `trial_${tag}_${stamp}`;
  const r = await call('POST', '/auth/register-password', {
    body: { username, password: 'matkhau123', confirmPassword: 'matkhau123' },
  });
  return { token: r.data.token, id: r.data.user.id };
}

const ent = (t) => call('GET', '/premium/entitlement', { token: t });

// ── Chưa dùng thử ───────────────────────────────────────────────────────────
const u1 = await newUser('a');
const s0 = await call('GET', '/premium/trial', { token: u1.token });
check('Người mới: chưa dùng thử, chưa chạy', s0.data?.active === false && s0.data?.hasTrialed === false);
check(
  'Điều khoản nói rõ 3 ngày và KHÔNG tự trừ tiền',
  s0.data?.terms?.days === 3 && s0.data?.terms?.autoCharge === false,
  JSON.stringify(s0.data?.terms),
);

const e0 = await ent(u1.token);
check('Chưa dùng thử → FREE', e0.data?.plan === 'FREE' && e0.data?.isTrial === false);

// ── Bắt đầu dùng thử ────────────────────────────────────────────────────────
const start = await call('POST', '/premium/trial/start', {
  token: u1.token,
  // Client cố khai thêm trường để kéo dài / nâng gói. Server phải bỏ qua.
  body: { deviceId: `dev-${stamp}-1`, days: 3650, plan: 'SQUAD', months: 99 },
});
check('Bắt đầu được dùng thử', start.data?.active === true, JSON.stringify(start.json)?.slice(0, 120));

const endsAt = new Date(start.data.endsAt);
const days = (endsAt - Date.now()) / 86400000;
check('Đúng 3 ngày, client không kéo dài được', days > 2.9 && days < 3.05, `${days.toFixed(3)} ngày`);
check('Client không nâng được lên SQUAD', start.data?.plan === 'PLUS', `plan=${start.data?.plan}`);
check('Mốc kết thúc là ISO UTC (không phụ thuộc múi giờ client)', start.data.endsAt.endsWith('Z'), start.data.endsAt);

const e1 = await ent(u1.token);
check('Đang dùng thử → quyền như bản trả phí', e1.data?.plan === 'PLUS' && e1.data?.via === 'trial' && e1.data?.isTrial === true, JSON.stringify(e1.data));
check('Hạn mức được nới ra', e1.data?.limits?.membersPerTrip === 30);

// Hạn mức thật sự được mở: tạo chuyến thứ 3 (bản Free chỉ được 2).
for (let i = 0; i < 3; i++) {
  await call('POST', '/trips', {
    token: u1.token,
    body: { name: `Thử ${i}`, startDate: '2026-10-01', endDate: '2026-10-03' },
  });
}
const t4 = await call('POST', '/trips', {
  token: u1.token,
  body: { name: 'Thử 4', startDate: '2026-10-01', endDate: '2026-10-03' },
});
check('Đang dùng thử → vượt được hạn mức 2 chuyến của bản Free', t4.status === 201 || t4.status === 200, `status=${t4.status}`);

// ── Không bắt đầu được hai lần ──────────────────────────────────────────────
const again = await call('POST', '/premium/trial/start', {
  token: u1.token,
  body: { deviceId: `dev-${stamp}-1` },
});
check('Đang có gói thì không bắt đầu lại được', again.json?.code === 'ALREADY_SUBSCRIBED', JSON.stringify(again.json)?.slice(0, 100));

// ── Hết hạn: quyền phải tự mất, KHÔNG chờ job ───────────────────────────────
// Kéo mốc hết hạn về quá khứ nhưng CỐ Ý giữ nguyên `status: TRIALING`, đúng
// như lúc job dọn hạn chưa kịp chạy.
await prisma.subscription.updateMany({
  where: { userId: u1.id, status: 'TRIALING' },
  data: { currentPeriodEnd: new Date(Date.now() - 60_000) },
});
const eExpired = await ent(u1.token);
check(
  'Hết hạn → rơi về FREE ngay, dù cột status vẫn là TRIALING',
  eExpired.data?.plan === 'FREE' && eExpired.data?.via === 'none',
  JSON.stringify(eExpired.data)?.slice(0, 90),
);

const t5 = await call('POST', '/trips', {
  token: u1.token,
  body: { name: 'Sau khi hết hạn', startDate: '2026-10-01', endDate: '2026-10-03' },
});
check('Hết hạn → bị chặn lại ở hạn mức Free', t5.json?.code === 'QUOTA_EXCEEDED', `status=${t5.status}`);

// ── Không dùng thử lần hai ──────────────────────────────────────────────────
const twice = await call('POST', '/premium/trial/start', {
  token: u1.token,
  body: { deviceId: `dev-${stamp}-1` },
});
check(
  'Đã dùng thử rồi → không được lần hai',
  twice.json?.code === 'TRIAL_NOT_ELIGIBLE' && twice.json?.reasons?.includes('ALREADY_TRIALED'),
  JSON.stringify(twice.json)?.slice(0, 120),
);

// ── Dừng giữa chừng thì cắt ngay ────────────────────────────────────────────
const u2 = await newUser('b');
await call('POST', '/premium/trial/start', {
  token: u2.token,
  body: { deviceId: `dev-${stamp}-2` },
});
check('User B bắt đầu được', (await ent(u2.token)).data?.isTrial === true);

const cancelled = await call('POST', '/premium/trial/cancel', { token: u2.token });
check('Huỷ được dùng thử', cancelled.data?.active === false, JSON.stringify(cancelled.json)?.slice(0, 90));
const e2 = await ent(u2.token);
check('Huỷ → mất quyền ngay (không có gì đã trả tiền để giữ)', e2.data?.plan === 'FREE', JSON.stringify(e2.data)?.slice(0, 80));

const cancelAgain = await call('POST', '/premium/trial/cancel', { token: u2.token });
check('Huỷ lần hai báo lỗi rõ ràng', cancelAgain.json?.code === 'NO_ACTIVE_TRIAL');

// ── Nhiều tài khoản cùng một máy ────────────────────────────────────────────
// u1 và u2 đã dùng chung? Không — mỗi người một deviceId. Giờ dựng một máy
// dùng chung thật sự.
const shared = `dev-shared-${stamp}`;
const c1 = await newUser('c1');
const r1 = await call('POST', '/premium/trial/start', { token: c1.token, body: { deviceId: shared } });
check('Máy mới, tài khoản đầu tiên → được thử', r1.data?.active === true);

const c2 = await newUser('c2');
const r2 = await call('POST', '/premium/trial/start', { token: c2.token, body: { deviceId: shared } });
check(
  'Cùng máy lần thứ 2 → VẪN được thử (máy dùng chung trong nhà là bình thường)',
  r2.data?.active === true,
  JSON.stringify(r2.json)?.slice(0, 100),
);
const claim2 = await prisma.trialClaim.findFirst({ where: { userId: c2.id } });
check('  → nhưng bị đánh dấu REVIEW để soi lại', claim2?.verdict === 'REVIEW', `verdict=${claim2?.verdict} reasons=${claim2?.reasons}`);

const c3 = await newUser('c3');
const r3 = await call('POST', '/premium/trial/start', { token: c3.token, body: { deviceId: shared } });
check(
  'Cùng máy lần thứ 3 → chặn (mẫu tạo tài khoản hàng loạt)',
  r3.json?.code === 'TRIAL_NOT_ELIGIBLE' && r3.json?.reasons?.includes('DEVICE_MULTIPLE_TRIALS'),
  JSON.stringify(r3.json)?.slice(0, 130),
);
const denied = await prisma.trialClaim.findFirst({ where: { userId: c3.id } });
check('  → lần bị từ chối vẫn được ghi lại (để đo chặn oan)', denied?.verdict === 'INELIGIBLE');

// ── Chung IP nhưng là người hợp lệ ──────────────────────────────────────────
// Cả bộ test này chạy từ cùng một IP. Nếu IP bị coi là một người thì c1 đã
// không thể bắt đầu sau u1/u2 — mà nó bắt đầu được, ở trên.
check('Chung IP không tự nó chặn ai (cả file chạy từ một IP)', r1.data?.active === true);

// ── Không lưu dữ liệu thô ───────────────────────────────────────────────────
const anyClaim = await prisma.trialClaim.findFirst({ where: { userId: c1.id } });
check(
  'Chỉ lưu băm, không lưu deviceId thô',
  anyClaim?.deviceHash?.length === 64 && anyClaim.deviceHash !== shared,
  `deviceHash=${anyClaim?.deviceHash?.slice(0, 16)}...`,
);

// ── Nhật ký trạng thái ──────────────────────────────────────────────────────
const events = await prisma.subscriptionEvent.findMany({ where: { userId: u1.id } });
check(
  'Có nhật ký TRIAL_STARTED',
  events.some((e) => e.type === 'TRIAL_STARTED'),
  events.map((e) => e.type).join(','),
);
const deniedEvents = await prisma.subscriptionEvent.findMany({ where: { userId: c3.id } });
check('Có nhật ký TRIAL_DENIED kèm lý do', deniedEvents.some((e) => e.type === 'TRIAL_DENIED'));

// ── Không xác thực thì không đụng được ──────────────────────────────────────
const noAuth = await call('POST', '/premium/trial/start', { body: { deviceId: 'x' } });
check('Không token → 401', noAuth.status === 401);

console.log(`\n${pass} pass, ${fail} fail`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
