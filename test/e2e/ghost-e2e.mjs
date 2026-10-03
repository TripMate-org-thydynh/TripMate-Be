/**
 * E2E Ghost Cam — ảnh ghost chưa tráng không được lộ qua API cho người khác.
 *
 *   SUITES=ghost-e2e npm run test:e2e:all
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const BASE = process.env.API || 'http://localhost:3000/api/v1';
const stamp = Date.now().toString(36);
const prisma = new PrismaClient();

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  console.error('DATABASE_URL không phải local — dừng.');
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* rỗng */ }
  return { status: res.status, json, data: json?.data };
}
const ok2xx = (r) => r.status === 200 || r.status === 201;
const md5uuid = (s) => {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
async function makeUser(tag) {
  const username = `gh_${tag}_${stamp}`;
  const user = await prisma.user.create({
    data: { email: `${username}@tripmate.local`, name: username, username, supabaseId: md5uuid(`pwd-${username}`) },
  });
  return { id: user.id, token: jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

const users = [];
try {
  const owner = await makeUser('own');
  const friend = await makeUser('fr');
  users.push(owner.id, friend.id);

  const t = await call('POST', '/trips', {
    token: owner.token,
    body: { name: `Ghost ${stamp}`, destination: 'Đà Lạt', startDate: '2027-01-10', endDate: '2027-01-13' },
  });
  const tripId = t.data?.id;
  check('Tạo chuyến', ok2xx(t), `status=${t.status}`);
  await prisma.tripMember.create({ data: { tripId, userId: friend.id, role: 'MEMBER' } });

  const ghost = await call('POST', `/trips/${tripId}/moments`, {
    token: owner.token,
    body: { mediaUrl: 'https://res.cloudinary.com/demo/image/upload/ghost.jpg', isGhost: true, caption: 'bí mật' },
  });
  const normal = await call('POST', `/trips/${tripId}/moments`, {
    token: owner.token,
    body: { mediaUrl: 'https://res.cloudinary.com/demo/image/upload/normal.jpg', caption: 'công khai' },
  });
  check('Đăng ảnh ghost + ảnh thường', ok2xx(ghost) && ok2xx(normal), `${ghost.status},${normal.status}`);
  const gid = ghost.data?.id;

  const mine = await call('GET', `/trips/${tripId}/moments`, { token: owner.token });
  const myGhost = mine.data?.find((m) => m.id === gid);
  check('Người chụp thấy ảnh ghost của mình, có cờ developing', myGhost?.developing === true && !!myGhost?.revealAt,
    JSON.stringify(myGhost)?.slice(0, 120));

  const theirs = await call('GET', `/trips/${tripId}/moments`, { token: friend.token });
  const ids = (theirs.data ?? []).map((m) => m.id);
  check('Bạn đồng hành KHÔNG thấy ảnh ghost trong danh sách', !ids.includes(gid) && ids.includes(normal.data?.id),
    JSON.stringify(ids));
  check('Không lộ URL ảnh ghost ở bất kỳ đâu trong danh sách',
    !JSON.stringify(theirs.json).includes('ghost.jpg'));

  const one = await call('GET', `/trips/${tripId}/moments/${gid}`, { token: friend.token });
  check('Xem chi tiết ảnh ghost bằng id → 404', one.status === 404, `status=${one.status}`);

  const react = await call('POST', `/trips/${tripId}/moments/${gid}/reactions`, { token: friend.token, body: { emoji: '🔥' } });
  const cmt = await call('POST', `/trips/${tripId}/moments/${gid}/comments`, { token: friend.token, body: { content: 'hé lộ?' } });
  check('Thả cảm xúc / bình luận ảnh chưa tráng → 404', react.status === 404 && cmt.status === 404,
    `${react.status},${cmt.status}`);

  const dev = await call('GET', `/trips/${tripId}/moments/developing`, { token: friend.token });
  check('Đếm ảnh đang tráng: 1 tấm, của bạn 0', dev.data?.total === 1 && dev.data?.mine === 0 && dev.data?.revealed === false,
    JSON.stringify(dev.json));

  const recap = await call('GET', `/trips/${tripId}/recap`, { token: friend.token });
  check('Recap không lộ ảnh ghost', recap.status !== 200 || !JSON.stringify(recap.json).includes('ghost.jpg'),
    `status=${recap.status}`);

  // Chuyến đã kết thúc → ảnh được tráng cho cả nhóm.
  await prisma.trip.update({ where: { id: tripId }, data: { startDate: new Date('2025-01-01'), endDate: new Date('2025-01-03') } });
  const after = await call('GET', `/trips/${tripId}/moments`, { token: friend.token });
  const revealed = after.data?.find((m) => m.id === gid);
  check('Hết chuyến: bạn đồng hành thấy ảnh, không còn cờ developing', !!revealed && !revealed.developing);
  const one2 = await call('GET', `/trips/${tripId}/moments/${gid}`, { token: friend.token });
  check('Hết chuyến: xem chi tiết được', one2.status === 200, `status=${one2.status}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  Script dừng giữa chừng :: ${e?.stack ?? e}`);
} finally {
  try {
    await prisma.trip.deleteMany({ where: { createdBy: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch { /* dọn không được thì thôi — DB test */ }
  await prisma.$disconnect();
}

console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
