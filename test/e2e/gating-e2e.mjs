/**
 * E2E cho hạn mức bản Free.
 *
 * Trước đây `FREE_LIMITS` khai báo bốn hạn mức nhưng **chỉ `activeTrips` có
 * chốt chặn** — ba cái còn lại không được kiểm ở bất kỳ đâu trong backend. Hệ
 * quả là người trả tiền thực tế chỉ nhận được đúng một thứ: tạo hơn 2 chuyến.
 *
 * File này kiểm cả bốn, và kiểm cả hai đường vào chuyến (mã mời và link mời) —
 * chặn một đường mà bỏ đường kia thì hạn mức chỉ là gợi ý.
 *
 *   npm run test:gating
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

/** Tạo một tài khoản mới và trả về token + id. */
async function newUser(tag) {
  const username = `gate_${tag}_${stamp}`;
  const r = await call('POST', '/auth/register-password', {
    body: { username, password: 'matkhau123', confirmPassword: 'matkhau123' },
  });
  return { token: r.data.token, id: r.data.user.id, username };
}

/** Lỗi vượt hạn mức phải nói rõ chạm cái gì, để paywall nói trúng chuyện. */
function isQuotaError(r, quota) {
  return (
    r.status === 403 &&
    r.json?.code === 'QUOTA_EXCEEDED' &&
    r.json?.quota === quota
  );
}

const owner = await newUser('own');

// ── activeTrips: bản Free được 2 ────────────────────────────────────────────
const trips = [];
for (let i = 0; i < 2; i++) {
  const r = await call('POST', '/trips', {
    token: owner.token,
    body: { name: `Chuyến ${i}`, startDate: '2026-10-01', endDate: '2026-10-03' },
  });
  trips.push(r.data);
}
check('Free tạo được 2 chuyến', trips.every((t) => t?.id));

const third = await call('POST', '/trips', {
  token: owner.token,
  body: { name: 'Chuyến 3', startDate: '2026-10-01', endDate: '2026-10-03' },
});
check('Chuyến thứ 3 bị chặn', isQuotaError(third, 'activeTrips'), JSON.stringify(third.json)?.slice(0, 110));

const trip = trips[0];

// ── membersPerTrip: bản Free được 8 (đã có chủ chuyến = 1) ──────────────────
const joiners = [];
for (let i = 0; i < 8; i++) joiners.push(await newUser(`m${i}`));

const results = [];
for (const j of joiners) {
  results.push(
    await call('POST', '/trips/join', {
      token: j.token,
      body: { inviteCode: trip.inviteCode },
    }),
  );
}
const okJoins = results.filter((r) => r.status === 200 || r.status === 201).length;
check('7 người vào được (tổng 8 thành viên)', okJoins === 7, `vào được ${okJoins}`);
check(
  'Người thứ 9 bị chặn đúng hạn mức membersPerTrip',
  isQuotaError(results[7], 'membersPerTrip'),
  JSON.stringify(results[7].json)?.slice(0, 110),
);

// Đường thứ hai vào chuyến: link mời. Phải chặn giống hệt.
const inv = await call('POST', `/trips/${trip.id}/invites`, { token: owner.token });
const code = inv.data?.code ?? inv.data?.inviteCode ?? inv.data?.token;
if (code) {
  const extra = await newUser('link');
  const viaLink = await call('POST', `/trips/join-link/${code}`, {
    token: extra.token,
  });
  check(
    'Link mời cũng bị chặn (không lách được bằng đường khác)',
    isQuotaError(viaLink, 'membersPerTrip'),
    `status=${viaLink.status} ${JSON.stringify(viaLink.json)?.slice(0, 100)}`,
  );
} else {
  check('Tạo được link mời', false, JSON.stringify(inv.json)?.slice(0, 120));
}

// ── momentsPerTrip: bản Free được 100 ───────────────────────────────────────
// Gieo thẳng 99 bản ghi thay vì gọi API 99 lần: hạn mức đọc từ DB nên kết quả
// giống hệt, mà không mất 99 vòng mạng.
await prisma.moment.createMany({
  data: Array.from({ length: 99 }, () => ({
    tripId: trip.id,
    userId: owner.id,
    mediaUrl: 'https://example.invalid/x.jpg',
    type: 'PHOTO',
  })),
});

const m100 = await call('POST', `/trips/${trip.id}/moments`, {
  token: owner.token,
  body: { mediaUrl: 'https://example.invalid/100.jpg', type: 'PHOTO' },
});
check('Moment thứ 100 vẫn đăng được', m100.status === 200 || m100.status === 201, `status=${m100.status}`);

const m101 = await call('POST', `/trips/${trip.id}/moments`, {
  token: owner.token,
  body: { mediaUrl: 'https://example.invalid/101.jpg', type: 'PHOTO' },
});
check('Moment thứ 101 bị chặn', isQuotaError(m101, 'momentsPerTrip'), JSON.stringify(m101.json)?.slice(0, 110));

// ── aiPerMonth: bản Free được 15 ────────────────────────────────────────────
// Gieo 15 bản ghi thay vì gọi Gemini 15 lần — vừa tốn quota thật, vừa chậm.
await prisma.aIRequest.createMany({
  data: Array.from({ length: 15 }, () => ({
    userId: owner.id,
    type: 'VIBE_MATCH',
    prompt: 'seed',
    status: 'COMPLETED',
  })),
});

const ai16 = await call('POST', '/ai/request', {
  token: owner.token,
  body: { type: 'VIBE_MATCH', prompt: 'Đà Lạt chill' },
});
check('Lời gọi AI thứ 16 bị chặn', isQuotaError(ai16, 'aiPerMonth'), JSON.stringify(ai16.json)?.slice(0, 110));

// ── Người trả tiền không bị chặn ────────────────────────────────────────────
// Cấp gói thẳng ở DB: luồng thanh toán đã có e2e riêng (`test:payment`), ở đây
// chỉ cần một người đang có gói để xem hạn mức có nới ra không.
const end = new Date();
end.setMonth(end.getMonth() + 1);
await prisma.subscription.create({
  data: {
    userId: owner.id,
    plan: 'PLUS',
    provider: 'CASH',
    externalId: `gating-${stamp}`,
    currentPeriodEnd: end,
  },
});

const ent = await call('GET', '/premium/entitlement', { token: owner.token });
check('Có gói → entitlement đổi sang PLUS', ent.data?.plan === 'PLUS', JSON.stringify(ent.data)?.slice(0, 90));

const paidTrip = await call('POST', '/trips', {
  token: owner.token,
  body: { name: 'Chuyến sau khi trả tiền', startDate: '2026-11-01', endDate: '2026-11-03' },
});
check('Có gói → tạo được chuyến thứ 3', paidTrip.status === 200 || paidTrip.status === 201, `status=${paidTrip.status}`);

const paidMoment = await call('POST', `/trips/${trip.id}/moments`, {
  token: owner.token,
  body: { mediaUrl: 'https://example.invalid/paid.jpg', type: 'PHOTO' },
});
check('Có gói → đăng được moment thứ 101', paidMoment.status === 200 || paidMoment.status === 201, `status=${paidMoment.status}`);

const paidJoin = await call('POST', '/trips/join', {
  token: joiners[7].token,
  body: { inviteCode: trip.inviteCode },
});
check('Có gói → thành viên thứ 9 vào được', paidJoin.status === 200 || paidJoin.status === 201, `status=${paidJoin.status}`);

console.log(`\n${pass} pass, ${fail} fail`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
