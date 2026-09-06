/**
 * E2E cho luồng mua gói qua ví.
 *
 * Trọng tâm là ba ca mà bản trước không chặn được, vì không có bảng đơn hàng
 * nào để đối chiếu:
 *   1. Client tự khai số tiền → phải bị bỏ qua, server chốt giá.
 *   2. Trả 1.000đ cho đơn 950.000đ → **không được cấp gói**.
 *   3. Cổng gọi lại webhook nhiều lần → chỉ cấp một kỳ.
 *
 * Cần một cổng giả vì credential Momo/ZaloPay thật không nằm trong repo:
 *
 *   node test/e2e/stub-gateway.mjs &
 *   MOMO_PARTNER_CODE=TESTPARTNER MOMO_ACCESS_KEY=testaccess  *   MOMO_SECRET_KEY=testsecret MOMO_ENDPOINT=http://localhost:4499/create  *   PUBLIC_API_URL=http://localhost:3000 npm run start:prod &
 *   npm run test:payment
 */
import { createHmac } from 'crypto';
const B = 'http://localhost:3000/api/v1';
const s = Date.now();
let pass = 0, fail = 0;
const check = (n, ok, d='') => { ok ? pass++ : fail++; console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`); };

const reg = await (await fetch(B+'/auth/register-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'pay_'+s,password:'matkhau123',confirmPassword:'matkhau123'})})).json();
const h = { authorization: 'Bearer '+reg.data.token, 'content-type':'application/json' };

const pl = (await (await fetch(B+'/premium/plans',{headers:h})).json()).data;
check('Bảng giá liệt kê cổng đã cấu hình', pl.gateways.includes('MOMO'), JSON.stringify(pl.gateways));

const o = (await (await fetch(B+'/premium/orders',{method:'POST',headers:h,body:JSON.stringify({plan:'SQUAD',months:12,provider:'MOMO'})})).json()).data;
check('Tạo đơn qua cổng, nhận payUrl', !!o?.payUrl, JSON.stringify(o)?.slice(0,120));
check('Giá do server chốt (SQUAD 12 tháng = 950.000)', o.amount === 950000, `amount=${o.amount}`);
const oid = o.orderId;

const stat = async () => (await (await fetch(B+'/premium/orders/'+oid,{headers:h})).json()).data?.status;
const ent  = async () => (await (await fetch(B+'/premium/entitlement',{headers:h})).json()).data;
check('Đơn mới ở trạng thái PENDING', await stat() === 'PENDING');
check('Chưa trả tiền thì vẫn là FREE', (await ent()).plan === 'FREE');

// Client gửi kèm amount → phải bị bỏ qua, không được rẻ đi
const cheat = (await (await fetch(B+'/premium/orders',{method:'POST',headers:h,body:JSON.stringify({plan:'SQUAD',months:12,provider:'MOMO',amount:1000,price:1000})})).json()).data;
check('Client gửi amount=1000 không làm đơn rẻ đi', cheat.amount === 950000, `amount=${cheat.amount}`);

// transId phải khác nhau giữa các lần chạy: `@@unique([provider, externalId])`
// coi cùng một transId là cùng một giao dịch, đúng như cổng thật.
const mk = (amount, transId, resultCode=0, orderId=oid) => {
  const raw = `accessKey=testaccess&amount=${amount}&extraData=&message=ok&orderId=${orderId}&orderInfo=x&orderType=momo_wallet&partnerCode=TESTPARTNER&payType=qr&requestId=r1&responseTime=1&resultCode=${resultCode}&transId=${transId}`;
  return { partnerCode:'TESTPARTNER', orderId, requestId:'r1', amount, orderInfo:'x', orderType:'momo_wallet', transId, resultCode, message:'ok', payType:'qr', responseTime:1, extraData:'', signature: createHmac('sha256','testsecret').update(raw).digest('hex') };
};
const ipn = (b) => fetch(B+'/payment/momo/ipn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());

const bad = await ipn({ orderId: oid, amount: 950000, resultCode: 0, signature: 'deadbeef' });
check('IPN sai chữ ký bị từ chối', bad.statusCode === 400, JSON.stringify(bad).slice(0,90));
check('  → vẫn FREE', (await ent()).plan === 'FREE');

await ipn(mk(1000, s % 1000000 + 1));
check('IPN đúng chữ ký nhưng SAI SỐ TIỀN không cấp gói', (await ent()).plan === 'FREE');
check('  → đơn bị đánh FAILED', await stat() === 'FAILED');

// Đơn mới, trả đúng tiền
const o2 = (await (await fetch(B+'/premium/orders',{method:'POST',headers:h,body:JSON.stringify({plan:'PLUS',months:1,provider:'MOMO'})})).json()).data;
await ipn(mk(o2.amount, s % 1000000 + 2, 0, o2.orderId));
const e2 = await ent();
check('IPN đúng tiền → cấp gói PLUS', e2.plan === 'PLUS' && e2.via === 'own', JSON.stringify(e2));
const until1 = e2.activeUntil;

// Gửi lại đúng IPN đó → không được cộng thêm kỳ
await ipn(mk(o2.amount, s % 1000000 + 2, 0, o2.orderId));
const e3 = await ent();
check('IPN trùng không cộng thêm kỳ (idempotent)', e3.activeUntil === until1, `${until1} vs ${e3.activeUntil}`);

// Đơn bị người dùng huỷ ở ví
const o3 = (await (await fetch(B+'/premium/orders',{method:'POST',headers:h,body:JSON.stringify({plan:'PLUS',months:1,provider:'MOMO'})})).json()).data;
await ipn(mk(o3.amount, s % 1000000 + 3, 1006, o3.orderId));
const s3 = (await (await fetch(B+'/premium/orders/'+o3.orderId,{headers:h})).json()).data;
check('Momo báo lỗi → đơn FAILED kèm lý do', s3.status === 'FAILED' && s3.failureReason === 'MOMO_1006', JSON.stringify(s3).slice(0,120));

// Đơn của người khác
const reg2 = await (await fetch(B+'/auth/register-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'pay_o_'+s,password:'matkhau123',confirmPassword:'matkhau123'})})).json();
const other = await (await fetch(B+'/premium/orders/'+oid,{headers:{authorization:'Bearer '+reg2.data.token}})).json();
check('Không xem được đơn của người khác', other.statusCode === 400, JSON.stringify(other).slice(0,90));

const bh = (await (await fetch(B+'/premium/billing-history',{headers:h})).json()).data;
check('Lịch sử thanh toán có đơn đã trả', bh.history.some(x => x.status === 'SUCCESS'), `n=${bh.history.length}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
