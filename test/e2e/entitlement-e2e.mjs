/**
 * E2E cho lớp cấp quyền (Phase 1 — nền kiếm tiền).
 *
 * Kiểm chứng đúng thứ trước đây không tồn tại: người trả tiền nhận được gì
 * khác người không trả, và hết hạn thì có bị thu quyền lại không.
 *
 *   node test/e2e/entitlement-e2e.mjs
 *
 * Cần backend chạy ở localhost:3000 và tài khoản demo_tripmate.
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
  return { status: res.status, json, data: json?.data };
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

  // Dọn gói cũ để mỗi lần chạy đều bắt đầu từ trạng thái free.
  await prisma.squadSeat.deleteMany({ where: { subscription: { userId } } });
  await prisma.subscription.deleteMany({ where: { userId } });

  console.log('\n— Bản Free —');
  const free = await call('GET', '/premium/entitlement', { token });
  check('Free: plan = FREE', free.data?.plan === 'FREE', JSON.stringify(free.data));
  check('Free: via = none', free.data?.via === 'none');
  check('Free: hạn mức chuyến = 2', free.data?.limits?.activeTrips === 2);

  const blocked = await call('POST', '/trips', {
    token,
    body: { name: 'E2E vượt hạn mức', startDate: '2026-10-01', endDate: '2026-10-03' },
  });
  check('Free: tạo chuyến quá hạn mức bị chặn 403', blocked.status === 403,
    `status=${blocked.status}`);
  check('Free: lỗi có mã máy đọc được', blocked.json?.code === 'QUOTA_EXCEEDED',
    JSON.stringify(blocked.json));
  check('Free: lỗi nói rõ hạn mức nào', blocked.json?.quota === 'activeTrips');

  console.log('\n— Sau khi trả tiền (gói PLUS 1 tháng) —');
  const end = new Date();
  end.setMonth(end.getMonth() + 1);
  await prisma.subscription.create({
    data: {
      userId,
      plan: 'PLUS',
      provider: 'MOMO',
      externalId: 'e2e-' + Date.now(),
      currentPeriodEnd: end,
    },
  });

  const paid = await call('GET', '/premium/entitlement', { token });
  check('Trả tiền: plan = PLUS', paid.data?.plan === 'PLUS', JSON.stringify(paid.data));
  check('Trả tiền: via = own', paid.data?.via === 'own');
  check('Trả tiền: hạn mức chuyến được nới', paid.data?.limits?.activeTrips > 2);

  const allowed = await call('POST', '/trips', {
    token,
    body: { name: 'E2E sau khi trả tiền', startDate: '2026-10-01', endDate: '2026-10-03' },
  });
  check('Trả tiền: tạo được chuyến thứ 3', allowed.status === 201 || allowed.status === 200,
    `status=${allowed.status}`);
  const newTripId = allowed.data?.id;

  console.log('\n— Huỷ gia hạn —');
  const canceled = await call('POST', '/premium/cancel', { token });
  check('Huỷ: đánh dấu cancelAtPeriodEnd', canceled.data?.cancelAtPeriodEnd === true,
    JSON.stringify(canceled.data));
  const afterCancel = await call('GET', '/premium/entitlement', { token });
  check('Huỷ: VẪN còn quyền tới hết kỳ đã trả', afterCancel.data?.via === 'own',
    JSON.stringify(afterCancel.data));

  console.log('\n— Hết hạn —');
  await prisma.subscription.updateMany({
    where: { userId },
    data: { currentPeriodEnd: new Date(Date.now() - 86400_000) },
  });
  const expired = await call('GET', '/premium/entitlement', { token });
  check('Hết hạn: rơi về FREE', expired.data?.plan === 'FREE', JSON.stringify(expired.data));
  check('Hết hạn: hạn mức thu lại', expired.data?.limits?.activeTrips === 2);

  console.log('\n— Ghế Squad Pass —');
  const owner = await prisma.user.findFirst({
    where: { id: { not: userId } },
    select: { id: true },
  });
  if (owner) {
    const sEnd = new Date();
    sEnd.setMonth(sEnd.getMonth() + 1);
    const squad = await prisma.subscription.create({
      data: {
        userId: owner.id,
        plan: 'SQUAD',
        provider: 'ZALOPAY',
        externalId: 'e2e-squad-' + Date.now(),
        currentPeriodEnd: sEnd,
        seats: 5,
      },
    });
    await prisma.squadSeat.create({
      data: { subscriptionId: squad.id, userId },
    });

    const seatEnt = await call('GET', '/premium/entitlement', { token });
    check('Ghế: nhận quyền qua Squad Pass của người khác',
      seatEnt.data?.plan === 'SQUAD' && seatEnt.data?.via === 'seat',
      JSON.stringify(seatEnt.data));

    // Gói gốc hết hạn thì ghế cũng mất giá trị.
    await prisma.subscription.update({
      where: { id: squad.id },
      data: { currentPeriodEnd: new Date(Date.now() - 86400_000) },
    });
    const deadSeat = await call('GET', '/premium/entitlement', { token });
    check('Ghế: mất quyền khi gói gốc hết hạn', deadSeat.data?.plan === 'FREE',
      JSON.stringify(deadSeat.data));

    await prisma.squadSeat.deleteMany({ where: { subscriptionId: squad.id } });
    await prisma.subscription.delete({ where: { id: squad.id } });
  } else {
    console.log('  BỎ QUA  không có user thứ hai để thử Squad Pass');
  }

  // Dọn dẹp.
  if (newTripId) {
    await prisma.trip.update({
      where: { id: newTripId },
      data: { deletedAt: new Date() },
    });
  }
  await prisma.subscription.deleteMany({ where: { userId } });

  console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
