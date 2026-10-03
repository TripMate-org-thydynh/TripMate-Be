/**
 * E2E xoá tài khoản — yêu cầu "Account deletion" của Google Play.
 *
 * Kiểm: dữ liệu cá nhân bị xoá thật (không chỉ khoá đăng nhập), token cũ hết
 * hiệu lực, và đăng ký lại đúng username đó vẫn được (trước đây đụng unique
 * vì supabaseId sinh từ username).
 *
 *   SUITES=account-delete-e2e npm run test:e2e:all
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const BASE = process.env.API || 'http://localhost:3000/api/v1';
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* body rỗng */ }
  return { status: res.status, json, data: json?.data };
}
const ok2xx = (r) => r.status === 200 || r.status === 201;

const username = `del_${Date.now().toString(36)}`;
const creds = { username, password: 'matkhau123', confirmPassword: 'matkhau123' };

try {
  const reg = await call('POST', '/auth/register-password', { body: creds });
  check('Đăng ký', ok2xx(reg), `status=${reg.status}`);
  const token = reg.data?.token;
  const userId = reg.data?.user?.id;

  await call('PATCH', '/users/me', { token, body: { bio: 'bio riêng tư', avatarUrl: 'https://example.com/a.png' } });
  await prisma.deviceToken.create({ data: { userId, token: `fcm-${username}`, platform: 'android' } })
    .catch(() => { /* schema khác thì bỏ qua phần này */ });

  const del = await call('DELETE', '/users/me', { token });
  check('DELETE /users/me thành công', ok2xx(del), `status=${del.status}`);

  const u = await prisma.user.findUnique({ where: { id: userId } });
  check('Hàng user đã ẩn danh hết PII',
    !!u?.deletedAt && u.username === null && u.passwordHash === null &&
      u.avatarUrl === null && u.bio === null && !u.email.includes(username) &&
      !u.name.includes(username),
    JSON.stringify({ name: u?.name, email: u?.email, username: u?.username }));

  const tokens = await prisma.deviceToken.count({ where: { userId } });
  check('Token thiết bị (FCM) đã xoá', tokens === 0, `còn ${tokens}`);

  const me = await call('GET', '/users/me', { token });
  check('Token phiên cũ bị từ chối', me.status === 401, `status=${me.status}`);

  const login = await call('POST', '/auth/login-password', { body: { username, password: creds.password } });
  check('Không đăng nhập lại được bằng mật khẩu cũ', login.status === 401, `status=${login.status}`);

  const again = await call('POST', '/auth/register-password', { body: creds });
  check('Đăng ký lại đúng username đó được', ok2xx(again), `status=${again.status} ${JSON.stringify(again.json)?.slice(0, 160)}`);
  check('Tài khoản mới là người khác', again.data?.user?.id && again.data.user.id !== userId);
} catch (e) {
  fail++;
  console.log(`  FAIL  Script dừng giữa chừng :: ${e?.stack ?? e}`);
} finally {
  await prisma.$disconnect();
}

console.log(`\nKết quả: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
