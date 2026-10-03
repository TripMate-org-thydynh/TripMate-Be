/**
 * E2E báo cáo nội dung (chính sách UGC Google Play).
 *
 *   SUITES=reports-e2e npm run test:e2e:all
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
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
const users = [];
async function makeUser(tag, role) {
  const username = `rp_${tag}_${stamp}`;
  const user = await prisma.user.create({
    data: { email: `${username}@tripmate.local`, name: username, username, supabaseId: md5uuid(`pwd-${username}`), ...(role ? { role } : {}) },
  });
  users.push(user.id);
  return { id: user.id, token: jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

try {
  const author = await makeUser('author');
  const r1 = await makeUser('r1');
  const r2 = await makeUser('r2');
  const r3 = await makeUser('r3');
  const admin = await makeUser('admin', 'ADMIN');

  const tpl = await prisma.itineraryTemplate.create({
    data: { authorId: author.id, title: `Mẫu xấu ${stamp}`, dayCount: 1, stopCount: 1, isPublic: true },
  });
  const privateTpl = await prisma.itineraryTemplate.create({
    data: { authorId: author.id, title: `Mẫu riêng ${stamp}`, dayCount: 1, stopCount: 1, isPublic: false },
  });

  const body = { targetType: 'TEMPLATE', targetId: tpl.id, reason: 'SPAM', note: 'quảng cáo' };
  const a = await call('POST', '/reports', { token: r1.token, body });
  check('Báo cáo mẫu công khai', ok2xx(a) && a.data?.hidden === false, JSON.stringify(a.json)?.slice(0, 160));

  const again = await call('POST', '/reports', { token: r1.token, body: { ...body, reason: 'HATE' } });
  const count1 = await prisma.contentReport.count({ where: { targetId: tpl.id } });
  check('Báo cáo lại cùng mục không tạo trùng', ok2xx(again) && count1 === 1, `count=${count1}`);

  const bad = await call('POST', '/reports', { token: r1.token, body: { ...body, reason: 'NOT_A_REASON' } });
  check('Lý do lạ → 400', bad.status === 400, `status=${bad.status}`);

  const hiddenProbe = await call('POST', '/reports', { token: r1.token, body: { ...body, targetId: privateTpl.id } });
  const ghostProbe = await call('POST', '/reports', { token: r1.token, body: { ...body, targetType: 'MOMENT', targetId: randomUUID() } });
  check('Không báo cáo được thứ mình không thấy (mẫu riêng, id lạ) → 404',
    hiddenProbe.status === 404 && ghostProbe.status === 404, `${hiddenProbe.status},${ghostProbe.status}`);

  const self = await call('POST', '/reports', { token: r1.token, body: { targetType: 'USER', targetId: r1.id, reason: 'OTHER' } });
  check('Không tự báo cáo chính mình', self.status === 403, `status=${self.status}`);

  await call('POST', '/reports', { token: r2.token, body });
  const third = await call('POST', '/reports', { token: r3.token, body });
  const after = await prisma.itineraryTemplate.findUnique({ where: { id: tpl.id } });
  check('3 người báo cáo → mẫu tự ẩn khỏi kho công khai', third.data?.hidden === true && after.isPublic === false,
    JSON.stringify(third.json)?.slice(0, 120));

  const notAdmin = await call('GET', '/admin/reports', { token: r1.token });
  check('Người thường không xem được hàng chờ admin', notAdmin.status === 403, `status=${notAdmin.status}`);

  const queue = await call('GET', '/admin/reports', { token: admin.token });
  const mine = (queue.data ?? []).filter((x) => x.targetId === tpl.id);
  check('Admin thấy 3 báo cáo đang mở', ok2xx(queue) && mine.length === 3, `n=${mine.length}`);

  const dismiss = await call('PATCH', `/admin/reports/${mine[0]?.id}`, { token: admin.token, body: { decision: 'DISMISSED' } });
  const reopened = await prisma.itineraryTemplate.findUnique({ where: { id: tpl.id } });
  const open = await prisma.contentReport.count({ where: { targetId: tpl.id, status: 'OPEN' } });
  check('Admin bác báo cáo → mẫu công khai lại, mọi báo cáo cùng mục đóng',
    ok2xx(dismiss) && reopened.isPublic === true && open === 0, `pub=${reopened.isPublic} open=${open}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  Script dừng giữa chừng :: ${e?.stack ?? e}`);
} finally {
  try { await prisma.user.deleteMany({ where: { id: { in: users } } }); } catch { /* DB test */ }
  await prisma.$disconnect();
}

console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
