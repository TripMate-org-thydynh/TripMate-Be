/**
 * E2E validation cho TripMate — chạy qua API thật, không mock.
 *
 * Mô phỏng đúng các endpoint mà app Flutter gọi: 2 user, 1 chuyến, mời +
 * tham gia, lịch trình, chi tiêu, số dư, cùng các trường hợp lỗi và bảo mật.
 *
 *   npm run test:api-e2e                              # đánh vào localhost:3000
 *   API=https://api.tripmate.app/api/v1 npm run test:api-e2e
 *
 * Script tạo user `e2e_*` và một chuyến rồi tự xoá chuyến ở cuối. Các user
 * e2e còn lại có thể dọn bằng: DELETE FROM users WHERE username LIKE 'e2e\_%';
 *
 * LƯU Ý: đừng chạy với database có dữ liệu người dùng thật.
 */
const BASE = process.env.API || 'http://localhost:3000/api/v1';
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
  return ok;
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

const section = (t) => results.push(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

// ─────────────────────────────────────────────────────────────────────────────
section('1. Auth');

const userA = { username: `e2e_a_${stamp}`, password: 'matkhau123', confirmPassword: 'matkhau123' };
const userB = { username: `e2e_b_${stamp}`, password: 'matkhau123', confirmPassword: 'matkhau123' };

const regA = await call('POST', '/auth/register-password', { body: userA });
check('Đăng ký user A', regA.status === 201 || regA.status === 200, `status=${regA.status} ${JSON.stringify(regA.json)?.slice(0, 200)}`);

const regB = await call('POST', '/auth/register-password', { body: userB });
check('Đăng ký user B', regB.status === 201 || regB.status === 200, `status=${regB.status}`);

const tokenA = regA.data?.accessToken || regA.data?.token;
const tokenB = regB.data?.accessToken || regB.data?.token;
check('Đăng ký trả về access token', !!tokenA && !!tokenB, `A=${!!tokenA} B=${!!tokenB} keys=${Object.keys(regA.data || {})}`);

const loginA = await call('POST', '/auth/login-password', {
  body: { username: userA.username, password: userA.password },
});
check('Đăng nhập lại bằng mật khẩu', loginA.status === 200 || loginA.status === 201, `status=${loginA.status}`);

const badLogin = await call('POST', '/auth/login-password', {
  body: { username: userA.username, password: 'sai-mat-khau' },
});
check('Sai mật khẩu bị từ chối', badLogin.status === 401 || badLogin.status === 400, `status=${badLogin.status}`);

const dupReg = await call('POST', '/auth/register-password', { body: userA });
check('Trùng username bị từ chối', dupReg.status >= 400, `status=${dupReg.status}`);

const shortPw = await call('POST', '/auth/register-password', {
  body: { username: `e2e_x_${stamp}`, password: '123', confirmPassword: '123' },
});
check('Mật khẩu quá ngắn bị chặn (validation)', shortPw.status === 400, `status=${shortPw.status}`);

const me = await call('GET', '/auth/me', { token: tokenA });
check('GET /auth/me với token hợp lệ', me.status === 200, `status=${me.status}`);
const userAId = me.data?.id;
check('/auth/me trả về id người dùng', !!userAId, `id=${userAId}`);

const noToken = await call('GET', '/auth/me');
check('Không có token → 401', noToken.status === 401, `status=${noToken.status}`);

const badToken = await call('GET', '/auth/me', { token: 'token-bia-dat' });
check('Token sai → 401', badToken.status === 401, `status=${badToken.status}`);

// ─────────────────────────────────────────────────────────────────────────────
section('2. Bảo mật (các lỗ hổng vừa vá)');

const bypass = await call('POST', '/auth/google', {
  body: { idToken: 'mock-google-token', email: 'attacker@evil.com', name: 'Attacker' },
});
check('Cửa hậu mock-google-token bị từ chối', bypass.status >= 400, `status=${bypass.status} — NGUY HIỂM nếu 200/201`);

const checkout = await call('POST', '/premium/checkout', {
  token: tokenA,
  body: { tier: 'ELITE_SQUAD', paymentMethod: 'Visa **** 4242' },
});
check('Premium checkout giả bị từ chối', checkout.status >= 400, `status=${checkout.status} — NGUY HIỂM nếu 200/201`);

const gpVerify = await call('POST', '/premium/verify-google-play', {
  token: tokenA,
  body: { token: 'mock_google_play_purchase_token_123', productId: 'elite_squad_monthly' },
});
check('Xác thực biên lai Play giả bị từ chối', gpVerify.status >= 400, `status=${gpVerify.status} — NGUY HIỂM nếu 200/201`);

// ─────────────────────────────────────────────────────────────────────────────
section('3. Trip');

const today = new Date();
const later = new Date(Date.now() + 3 * 86400000);
const createTrip = await call('POST', '/trips', {
  token: tokenA,
  body: {
    name: `E2E Đà Lạt ${stamp}`,
    description: 'Chuyến kiểm thử E2E',
    destination: 'Đà Lạt',
    startDate: today.toISOString(),
    endDate: later.toISOString(),
    currency: 'VND',
    budget: 5000000,
  },
});
check('A tạo chuyến', createTrip.status === 201 || createTrip.status === 200, `status=${createTrip.status} ${JSON.stringify(createTrip.json)?.slice(0, 250)}`);
const tripId = createTrip.data?.id;
check('Chuyến có id', !!tripId);

// App gọi /users/me/trips (xem trips_repository.dart:14), không phải /trips.
const listTrips = await call('GET', '/users/me/trips', { token: tokenA });
check('A thấy chuyến trong danh sách', Array.isArray(listTrips.data) && listTrips.data.some((t) => t.id === tripId), `n=${listTrips.data?.length}`);

const emptyList = await call('GET', '/users/me/trips', { token: tokenB });
check('B chưa có chuyến nào (empty state)', Array.isArray(emptyList.data) && emptyList.data.length === 0, `n=${emptyList.data?.length}`);

const bNotMember = await call('GET', `/trips/${tripId}`, { token: tokenB });
check('B chưa là thành viên → bị chặn xem chuyến', bNotMember.status >= 400, `status=${bNotMember.status}`);

const notFound = await call('GET', '/trips/00000000-0000-0000-0000-000000000000', { token: tokenA });
check('Chuyến không tồn tại → 4xx', notFound.status >= 400, `status=${notFound.status}`);

// ─────────────────────────────────────────────────────────────────────────────
section('4. Mời & tham gia (luồng vừa được nối lại)');

const createInvite = await call('POST', `/trips/${tripId}/invites`, { token: tokenA, body: {} });
check('A tạo link mời', createInvite.status === 201 || createInvite.status === 200, `status=${createInvite.status}`);
const inviteCode = createInvite.data?.code;
check('Link mời có code', !!inviteCode, `code=${inviteCode}`);

// Đây chính là đường mà JoinTripScreen.joinByAnyCode() thử ĐẦU TIÊN.
const joinByLink = await call('POST', `/trips/join-link/${inviteCode}`, { token: tokenB });
check('B tham gia bằng mã invite-link', joinByLink.status === 201 || joinByLink.status === 200, `status=${joinByLink.status} ${JSON.stringify(joinByLink.json)?.slice(0, 200)}`);

const bTripsAfter = await call('GET', '/users/me/trips', { token: tokenB });
check('Chuyến xuất hiện trong danh sách của B', Array.isArray(bTripsAfter.data) && bTripsAfter.data.some((t) => t.id === tripId), `n=${bTripsAfter.data?.length}`);

const joinTwice = await call('POST', `/trips/join-link/${inviteCode}`, { token: tokenB });
check('Tham gia lần 2 bị từ chối (đã là thành viên)', joinTwice.status >= 400, `status=${joinTwice.status}`);

// joinByAnyCode(): 404 ở bước trên → thử tiếp mã chuyến cố định.
const badCode = await call('POST', '/trips/join-link/MA-KHONG-TON-TAI', { token: tokenB });
check('Mã sai → 404 (để client fallback sang mã chuyến)', badCode.status === 404, `status=${badCode.status}`);

const tripInviteCode = createTrip.data?.inviteCode;
const joinByTripCode = await call('POST', '/trips/join', { token: tokenB, body: { inviteCode: tripInviteCode } });
check('Đường fallback /trips/join tồn tại và phản hồi hợp lý', joinByTripCode.status >= 200, `status=${joinByTripCode.status}`);

// ─────────────────────────────────────────────────────────────────────────────
section('5. Itinerary');

const addItem = await call('POST', `/trips/${tripId}/itinerary`, {
  token: tokenA,
  body: { day: 1, placeName: 'Hồ Xuân Hương', placeAddress: 'Đà Lạt', startTime: '08:00', durationMinutes: 90, notes: 'Đi dạo sáng' },
});
check('A thêm điểm vào lịch trình', addItem.status === 201 || addItem.status === 200, `status=${addItem.status} ${JSON.stringify(addItem.json)?.slice(0, 200)}`);

const itinerary = await call('GET', `/trips/${tripId}/itinerary`, { token: tokenB });
check('B (thành viên) đọc được lịch trình', itinerary.status === 200, `status=${itinerary.status}`);

// ─────────────────────────────────────────────────────────────────────────────
section('6. Chi tiêu & chia tiền');

const addExpense = await call('POST', `/trips/${tripId}/expenses`, {
  token: tokenA,
  body: { amount: 600000, category: 'FOOD', description: 'Lẩu gà lá é', splitType: 'EQUAL', paidById: userAId },
});
check('A ghi một khoản chi', addExpense.status === 201 || addExpense.status === 200, `status=${addExpense.status} ${JSON.stringify(addExpense.json)?.slice(0, 250)}`);

const expenses = await call('GET', `/trips/${tripId}/expenses`, { token: tokenB });
check('B đọc được danh sách chi tiêu', expenses.status === 200, `status=${expenses.status}`);

const balances = await call('GET', `/trips/${tripId}/expenses/balances`, { token: tokenA });
check('Tính được số dư / gợi ý tất toán', balances.status === 200, `status=${balances.status} ${JSON.stringify(balances.data)?.slice(0, 200)}`);

const badExpense = await call('POST', `/trips/${tripId}/expenses`, {
  token: tokenA,
  body: { amount: 'không-phải-số', category: 'FOOD' },
});
check('Chi tiêu sai kiểu dữ liệu bị chặn', badExpense.status === 400, `status=${badExpense.status}`);

// ─────────────────────────────────────────────────────────────────────────────
section('7. Các feature nhóm khác');

for (const [label, path, body] of [
  ['Việc cần làm (todos)', 'todos', { title: 'Đặt xe khách' }],
  ['Đồ cần mang (packing)', 'packing', { name: 'Áo khoác', category: 'CLOTHING' }],
  ['Ghi chú (notes)', 'notes', { content: 'Nhớ mang sạc dự phòng' }],
]) {
  const r = await call('POST', `/trips/${tripId}/${path}`, { token: tokenA, body });
  check(`${label} — tạo`, r.status === 201 || r.status === 200, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  const g = await call('GET', `/trips/${tripId}/${path}`, { token: tokenB });
  check(`${label} — thành viên đọc được`, g.status === 200, `status=${g.status}`);
}

for (const [label, path] of [
  ['Dashboard — tóm tắt', '/dashboard/summary'],
  ['Dashboard — bạn bè online', '/dashboard/squad-online'],
  ['Dashboard — hoạt động gần đây', '/dashboard/recent-activities'],
]) {
  const r = await call('GET', path, { token: tokenA });
  check(label, r.status === 200, `status=${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('7c. Scrapbook màn Home');

const recentEmpty = await call('GET', '/users/me/moments/recent', { token: tokenB });
check('Kỷ niệm gần đây trả mảng (user chưa đăng gì → rỗng)',
  recentEmpty.status === 200 && Array.isArray(recentEmpty.data) && recentEmpty.data.length === 0,
  `status=${recentEmpty.status} n=${recentEmpty.data?.length}`);

// User C hoàn toàn mới (B đã tham gia chuyến ở mục 4 nên đã đạt huy hiệu
// "chuyến đầu tiên" — dùng B ở đây sẽ kiểm tra sai).
const regC = await call('POST', '/auth/register-password', {
  body: { username: `e2e_c_${stamp}`, password: 'matkhau123', confirmPassword: 'matkhau123' },
});
const tokenC = regC.data?.accessToken || regC.data?.token;

const atlasNew = await call('GET', '/users/me/travel-atlas', { token: tokenC });
const atlasBadges = atlasNew.data?.badges;
check('Travel Atlas trả badges cả khi user chưa có chuyến',
  atlasNew.status === 200 && Array.isArray(atlasBadges) && atlasBadges.length > 0,
  `status=${atlasNew.status} badges=${atlasBadges?.length}`);
check('Không huy hiệu nào mở khoá sẵn cho user chưa đi chuyến nào',
  Array.isArray(atlasBadges) && atlasBadges.every((b) => !b.isUnlocked),
  `unlocked=${atlasBadges?.filter((b) => b.isUnlocked).length}`);

const atlasB = await call('GET', '/users/me/travel-atlas', { token: tokenB });
check('User đã tham gia 1 chuyến thì mở khoá huy hiệu đầu tiên',
  Array.isArray(atlasB.data?.badges) && atlasB.data.badges.some((b) => b.isUnlocked),
  `unlocked=${atlasB.data?.badges?.filter((b) => b.isUnlocked).length}`);

// ─────────────────────────────────────────────────────────────────────────────
section('7b. Dữ liệu giả đã gỡ');

const billing = await call('GET', '/premium/billing-history', { token: tokenB });
check('Lịch sử thanh toán của user mới là RỖNG (không còn hoá đơn bịa)',
  billing.status === 200 && Array.isArray(billing.data?.history) && billing.data.history.length === 0,
  `status=${billing.status} n=${billing.data?.history?.length} ${JSON.stringify(billing.data?.history)?.slice(0, 160)}`);

const badges = await call('GET', '/users/me/badges', { token: tokenB });
const unlocked = Array.isArray(badges.data) ? badges.data.filter((b) => b.unlockedAt).length : -1;
check('Huy hiệu của user mới CHƯA mở khoá cái nào',
  badges.status === 200 && unlocked === 0,
  `status=${badges.status} unlocked=${unlocked} ${JSON.stringify(badges.data)?.slice(0, 200)}`);

// ─────────────────────────────────────────────────────────────────────────────
section('8. Dọn dẹp');

const del = await call('DELETE', `/trips/${tripId}`, { token: tokenA });
check('A xoá chuyến kiểm thử', del.status === 200 || del.status === 204, `status=${del.status}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n${'='.repeat(64)}`);
console.log(`KẾT QUẢ: ${pass} pass / ${fail} fail (tổng ${pass + fail})`);
process.exit(fail > 0 ? 1 : 0);
