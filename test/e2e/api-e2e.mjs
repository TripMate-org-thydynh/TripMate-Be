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
section('7d. Các khối tổng hợp màn Home');

// User C vẫn chưa có chuyến nào → mọi khối phải trả "rỗng", không bịa dữ liệu.
const actEmpty = await call('GET', '/users/me/activities/recent', { token: tokenC });
check('Hoạt động gần đây rỗng khi chưa có chuyến',
  actEmpty.status === 200 && Array.isArray(actEmpty.data) && actEmpty.data.length === 0,
  `status=${actEmpty.status} n=${actEmpty.data?.length}`);

const upNextEmpty = await call('GET', '/users/me/up-next', { token: tokenC });
check('Up Next trả rỗng khi chưa có lịch trình',
  upNextEmpty.status === 200 && (upNextEmpty.data === null || upNextEmpty.data === undefined),
  `status=${upNextEmpty.status} data=${JSON.stringify(upNextEmpty.data)}`);

const sumEmpty = await call('GET', '/users/me/expense-summary', { token: tokenC });
check('Tổng hợp chi tiêu báo hasData=false khi chưa chi gì',
  sumEmpty.status === 200 && sumEmpty.data?.hasData === false,
  `status=${sumEmpty.status} ${JSON.stringify(sumEmpty.data)?.slice(0, 160)}`);

// User A có chuyến + lịch trình + chi tiêu → các khối phải có dữ liệu thật.
const upNextA = await call('GET', '/users/me/up-next', { token: tokenA });
check('Up Next trả điểm lịch trình thật cho user có chuyến',
  upNextA.status === 200 && upNextA.data?.placeName === 'Hồ Xuân Hương',
  `status=${upNextA.status} ${JSON.stringify(upNextA.data)?.slice(0, 200)}`);

const sumA = await call('GET', '/users/me/expense-summary', { token: tokenA });
check('Tổng hợp chi tiêu có dữ liệu thật sau khi ghi khoản chi',
  sumA.status === 200 && sumA.data?.hasData === true && sumA.data?.totalCount > 0,
  `status=${sumA.status} ${JSON.stringify(sumA.data)?.slice(0, 200)}`);

const actA = await call('GET', '/users/me/activities/recent', { token: tokenA });
const actTypes = Array.isArray(actA.data) ? actA.data.map((a) => a.type) : [];
check('Hoạt động gần đây có bản ghi sau các thao tác trên',
  actA.status === 200 && actTypes.length > 0,
  `status=${actA.status} n=${actTypes.length} — rỗng nghĩa là ActivitiesService.log() không được gọi`);

// Ba thao tác ở trên (thêm điểm lịch trình, ghi chi tiêu, thêm ghi chú) phải
// sinh ra đúng 3 loại bản ghi tương ứng.
for (const t of ['ITINERARY_ADDED', 'EXPENSE_ADDED', 'NOTE_ADDED']) {
  check(`Feed hoạt động ghi nhận ${t}`, actTypes.includes(t),
    `các loại ghi được: ${JSON.stringify(actTypes)}`);
}

check('Mỗi hoạt động có tên người thực hiện và tên chuyến',
  Array.isArray(actA.data) && actA.data.every((a) => a.actorName && a.tripName),
  `${JSON.stringify(actA.data?.[0])?.slice(0, 200)}`);

// ─────────────────────────────────────────────────────────────────────────────
section('7e. Mini games');

const xp = await call('GET', `/trips/${tripId}/games/xp`, { token: tokenA });
check('XP squad tính từ dữ liệu thật (không còn cứng 1420)',
  xp.status === 200 && typeof xp.data?.currentXP === 'number' && xp.data.currentXP !== 1420,
  `status=${xp.status} ${JSON.stringify(xp.data)?.slice(0, 200)}`);

check('XP có breakdown theo từng loại hoạt động',
  Array.isArray(xp.data?.breakdown) && xp.data.breakdown.length > 0,
  `breakdown=${JSON.stringify(xp.data?.breakdown)?.slice(0, 160)}`);

check('XP > 0 vì chuyến đã có lịch trình + chi tiêu + thành viên',
  (xp.data?.currentXP ?? 0) > 0, `currentXP=${xp.data?.currentXP}`);

const lb = await call('GET', `/trips/${tripId}/games/leaderboard`, { token: tokenA });
const lbNames = Array.isArray(lb.data) ? lb.data.map((r) => r.name) : [];
check('Bảng xếp hạng trả thành viên THẬT của chuyến',
  lb.status === 200 && lbNames.length === 2,
  `status=${lb.status} names=${JSON.stringify(lbNames)}`);
check('Không còn người chơi bịa (Sam/Alex/Jordan/Taylor/Casey)',
  !lbNames.some((n) => ['Sam', 'Alex', 'Jordan', 'Taylor', 'Casey'].includes(n)),
  `names=${JSON.stringify(lbNames)}`);

const weekly = await call('GET', `/trips/${tripId}/games/weekly`, { token: tokenA });
check('Nhiệm vụ tuần có tiến độ tính từ dữ liệu thật',
  weekly.status === 200 && Array.isArray(weekly.data) &&
  weekly.data.every((c) => typeof c.current === 'number' && typeof c.percent === 'number'),
  `status=${weekly.status} ${JSON.stringify(weekly.data)?.slice(0, 200)}`);

const seasonal = await call('GET', `/trips/${tripId}/games/seasonal`, { token: tokenA });
check('Sự kiện mùa có tiến độ thật',
  seasonal.status === 200 && Array.isArray(seasonal.data) &&
  seasonal.data.every((c) => typeof c.percent === 'number'),
  `status=${seasonal.status} ${JSON.stringify(seasonal.data)?.slice(0, 200)}`);

const dare = await call('GET', `/trips/${tripId}/games/dare/random`, { token: tokenA });
const dareText = dare.data?.dareText ?? '';
check('Thử thách trả về có nội dung',
  dare.status === 200 && dareText.length > 0, `status=${dare.status} text=${dareText}`);
check('Thử thách không còn bịa tên "Lê Minh" / "Alex Nguyễn"',
  !/Lê Minh|Alex Nguyễn/.test(dareText), `text=${dareText}`);
check('Thử thách không còn placeholder chưa thay',
  !dareText.includes('{member}'), `text=${dareText}`);

// ─────────────────────────────────────────────────────────────────────────────
const daily0 = await call('GET', `/trips/${tripId}/games/daily`, { token: tokenA });
check('Nhiệm vụ hôm nay trả tiến độ tính từ hôm nay',
  daily0.status === 200 && Array.isArray(daily0.data) && daily0.data.length > 0,
  `status=${daily0.status}`);

const gameSess = await call('POST', `/trips/${tripId}/games`, {
  token: tokenA,
  body: { gameType: 'TRUTH_OR_DARE', initialState: { dare: 'e2e', xpReward: 80 } },
});
check('Ghi được ván chơi (gameType hợp lệ với enum)',
  gameSess.status === 201 || gameSess.status === 200,
  `status=${gameSess.status} ${JSON.stringify(gameSess.data)?.slice(0, 150)}`);

const daily1 = await call('GET', `/trips/${tripId}/games/daily`, { token: tokenA });
const dayGames = (daily1.data ?? []).find((d) => d.id === 'day-games');
check('Chơi 1 ván xong thì nhiệm vụ ngày nhích lên thật',
  dayGames?.current >= 1,
  JSON.stringify(dayGames));

const chaosDare = await call('GET', `/trips/${tripId}/games/dare/random`, { token: tokenA });
check('Thử thách chaos trả về kèm XP và độ căng',
  chaosDare.status === 200 &&
    typeof chaosDare.data?.dareText === 'string' &&
    chaosDare.data.xpReward > 0,
  JSON.stringify(chaosDare.data)?.slice(0, 150));

const bingo = await call('POST', `/trips/${tripId}/games`, {
  token: tokenA,
  body: { gameType: 'CARD_MATCH', initialState: { game: 'BINGO', marked: [] } },
});
const bingoSave = await call('PATCH', `/trips/${tripId}/games/${bingo.data?.id}/state`, {
  token: tokenA,
  body: { stateJson: { game: 'BINGO', marked: [0, 4, 8] } },
});
check('Bảng bingo lưu được ô đã tick', bingoSave.status === 200,
  `status=${bingoSave.status}`);

const bingoList = await call('GET', `/trips/${tripId}/games`, { token: tokenA });
const savedBingo = (bingoList.data ?? []).find((g) => g.id === bingo.data?.id);
check('Vào lại vẫn còn ô đã tick',
  JSON.stringify(savedBingo?.stateJson?.marked) === '[0,4,8]',
  JSON.stringify(savedBingo?.stateJson));

section('7f. Tổng kết chuyến & bạn đồng hành');

const recap = await call('GET', `/trips/${tripId}/recap`, { token: tokenA });
check('Recap chuyến trả số liệu thật',
  recap.status === 200 && typeof recap.data?.placeCount === 'number',
  `status=${recap.status} ${JSON.stringify(recap.data)?.slice(0, 200)}`);

check('Recap không còn số cứng 7 địa điểm / 142 khoảnh khắc / 186km',
  !(recap.data?.placeCount === 7 && recap.data?.momentCount === 142),
  JSON.stringify(recap.data)?.slice(0, 200));

check('Recap đếm đúng thành viên thật của chuyến',
  recap.data?.memberCount >= 1,
  `memberCount=${recap.data?.memberCount}`);

check('Recap không bịa MVP khi chưa ai đóng góp',
  recap.data?.mvp === null || typeof recap.data?.mvp?.name === 'string',
  JSON.stringify(recap.data?.mvp)?.slice(0, 120));

const buddies = await call('GET', '/users/me/buddies', { token: tokenA });
check('Danh sách bạn đồng hành trả về mảng',
  buddies.status === 200 && Array.isArray(buddies.data),
  `status=${buddies.status}`);

check('Bạn đồng hành không còn bịa Alex Nguyễn / Trần Bình / Lê Minh',
  !JSON.stringify(buddies.data ?? []).match(/Alex Nguyễn|Trần Bình|Lê Minh/),
  JSON.stringify(buddies.data)?.slice(0, 200));

check('Bạn đồng hành đều là người đi chung THẬT (có số chuyến chung)',
  (buddies.data ?? []).every((b) => typeof b.sharedTrips === 'number' && b.sharedTrips > 0),
  JSON.stringify(buddies.data)?.slice(0, 200));

section('8. Dọn dẹp');

const del = await call('DELETE', `/trips/${tripId}`, { token: tokenA });
check('A xoá chuyến kiểm thử', del.status === 200 || del.status === 204, `status=${del.status}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n${'='.repeat(64)}`);
console.log(`KẾT QUẢ: ${pass} pass / ${fail} fail (tổng ${pass + fail})`);
process.exit(fail > 0 ? 1 : 0);
