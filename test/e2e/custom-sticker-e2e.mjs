/**
 * E2E sticker cá nhân: chỉ nhận ảnh Cloudinary của app, chỉ chủ gửi được,
 * ảnh của tin sticker do server đặt (client không chèn URL lạ được).
 *
 *   SUITES=custom-sticker-e2e npm run test:e2e:all
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
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'demo';

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
const users = [];
async function makeUser(tag) {
  const username = `cs_${tag}_${stamp}`;
  const user = await prisma.user.create({
    data: { email: `${username}@tripmate.local`, name: username, username, supabaseId: md5uuid(`pwd-${username}`) },
  });
  users.push(user.id);
  return { id: user.id, token: jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

try {
  const a = await makeUser('a');
  const b = await makeUser('b');
  const t = await call('POST', '/trips', {
    token: a.token,
    body: { name: `Sticker ${stamp}`, destination: 'Huế', startDate: '2027-02-01', endDate: '2027-02-03' },
  });
  const tripId = t.data?.id;
  await prisma.tripMember.create({ data: { tripId, userId: b.id, role: 'MEMBER' } });

  const evil = await call('POST', '/xp/stickers/custom', { token: a.token, body: { mediaUrl: 'https://evil.example/track.gif' } });
  const otherCloud = await call('POST', '/xp/stickers/custom', {
    token: a.token, body: { mediaUrl: `https://res.cloudinary.com/${CLOUD}x/image/upload/a.png` },
  });
  check('URL ngoài Cloudinary của app bị từ chối', evil.status === 400 && otherCloud.status === 400,
    `${evil.status},${otherCloud.status}`);

  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/tripmate/trips/${tripId}/s.png`;
  const mk = await call('POST', '/xp/stickers/custom', { token: a.token, body: { mediaUrl: url, label: '  mặt ngố  ' } });
  const sid = mk.data?.id;
  check('Tạo sticker cá nhân', ok2xx(mk) && mk.data?.label === 'mặt ngố', JSON.stringify(mk.json)?.slice(0, 160));

  const mine = await call('GET', '/xp/stickers/custom', { token: a.token });
  check('Danh sách sticker của tôi có sticker vừa tạo', (mine.data ?? []).some((s) => s.id === sid));

  const send = await call('POST', `/trips/${tripId}/chat`, {
    token: a.token, body: { type: 'STICKER', content: `custom:${sid}`, mediaUrl: 'https://evil.example/x.gif' },
  });
  check('Chủ gửi được; ảnh tin nhắn là ảnh sticker, không phải URL client gửi',
    ok2xx(send) && send.data?.mediaUrl === url, JSON.stringify(send.json)?.slice(0, 200));

  const steal = await call('POST', `/trips/${tripId}/chat`, { token: b.token, body: { type: 'STICKER', content: `custom:${sid}` } });
  check('Người khác không gửi được sticker của tôi', steal.status === 403, `status=${steal.status}`);

  const emojiSticker = await call('POST', `/trips/${tripId}/chat`, {
    token: a.token, body: { type: 'STICKER', content: 'stk-laugh', mediaUrl: 'https://evil.example/x.gif' },
  });
  check('Sticker emoji chưa sở hữu vẫn bị chặn', emojiSticker.status === 403, `status=${emojiSticker.status}`);

  const del = await call('DELETE', `/xp/stickers/custom/${sid}`, { token: b.token });
  check('Người khác không xoá được sticker của tôi', del.status === 404, `status=${del.status}`);
  const del2 = await call('DELETE', `/xp/stickers/custom/${sid}`, { token: a.token });
  const after = await call('POST', `/trips/${tripId}/chat`, { token: a.token, body: { type: 'STICKER', content: `custom:${sid}` } });
  check('Xoá xong thì không gửi được nữa', ok2xx(del2) && after.status === 404, `${del2.status},${after.status}`);

  await prisma.customSticker.createMany({
    data: Array.from({ length: 30 }, () => ({ userId: a.id, mediaUrl: url })),
  });
  const over = await call('POST', '/xp/stickers/custom', { token: a.token, body: { mediaUrl: url } });
  check('Quá 30 sticker → 403', over.status === 403, `status=${over.status}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  Script dừng giữa chừng :: ${e?.stack ?? e}`);
} finally {
  try { await prisma.user.deleteMany({ where: { id: { in: users } } }); } catch { /* DB test */ }
  await prisma.$disconnect();
}

console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
