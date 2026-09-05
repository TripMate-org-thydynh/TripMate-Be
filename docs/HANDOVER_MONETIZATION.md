# Bàn giao — Nền kiếm tiền TripMate

Cập nhật: 2026-09-05 · Đọc cùng [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md) và [PRODUCT_STRATEGY.md](PRODUCT_STRATEGY.md)

Tài liệu này dành cho người tiếp nhận phần **thanh toán và gói đăng ký**. Mục
tiêu: đọc xong là bắt tay code được ngay, không phải dò lại lịch sử.

---

## 1. Tóm tắt một đoạn

Nền cấp quyền **đã xong và đã kiểm chứng**: có bảng `Subscription`, có
`EntitlementService` trả lời "người này được dùng gì", hạn mức Free đã chặn thật,
webhook đã xác thực chữ ký và cấp quyền, paywall đã hiện đúng thứ vừa bị chặn.

Thứ **chưa có** là khâu **khởi tạo thanh toán**: chưa gọi được sang Momo/ZaloPay
để lấy link trả tiền, và chưa xác thực biên lai Google Play. Nói cách khác —
đường *về* (webhook → cấp quyền) đã thông, đường *đi* (app → cổng) thì chưa.

---

## 2. Đã làm

### 2.1. Database

| Thực thể | Ở đâu | Ghi chú |
| --- | --- | --- |
| `Subscription` | `prisma/schema.prisma` | Nguồn sự thật duy nhất cho trạng thái gói |
| `SquadSeat` | cùng file | Ghế Squad Pass cấp cho người khác dùng ké |
| enum `Plan` | `FREE` / `PLUS` / `SQUAD` | |
| enum `SubStatus` | `ACTIVE` / `PAST_DUE` / `CANCELED` / `EXPIRED` | |

Đã `prisma db push` lên Supabase. **Chưa có file migration** — xem mục Nợ.

Ràng buộc đáng chú ý: `@@unique([provider, externalId])`. Đây là thứ chặn cấp
trùng kỳ khi cổng gọi lại webhook nhiều lần cho cùng một giao dịch — **đừng gỡ**.

### 2.2. Backend

| Thành phần | File | Trạng thái |
| --- | --- | --- |
| `EntitlementService` | `src/modules/premium/entitlement.service.ts` | Xong, có test |
| `GET /premium/entitlement` | `premium.controller.ts` | Xong |
| `POST /premium/cancel` | `premium.controller.ts` | Xong |
| `GET /premium/subscriptions` | `premium.service.ts` | Đã đổi nguồn sang `Subscription` |
| Webhook Momo `POST /payment/momo/ipn` | `premium.service.ts` | Xác thực chữ ký + cấp quyền |
| Webhook ZaloPay `POST /payment/zalopay/ipn` | `premium.service.ts` | Như trên |
| Hạn mức `activeTrips` | `trips.service.ts:37` | Đã chặn thật |
| Giữ chi tiết lỗi | `common/filters/http-exception.filter.ts` | Trả `code`/`quota`/`limit` |
| `@RawResponse()` | `common/interceptors/transform.interceptor.ts` | Cho webhook trả nguyên văn |

### 2.3. App (Flutter)

| Thành phần | File |
| --- | --- |
| `entitlementProvider` | `lib/features/premium/data/entitlement_provider.dart` |
| `PaywallSheet` | `lib/features/premium/presentation/paywall_sheet.dart` |
| `ApiException.details` | `lib/core/network/api_exception.dart` |
| Nối paywall vào tạo chuyến | `lib/features/trips/presentation/create_trip_sheet.dart` |

### 2.4. Kiểm chứng

| Bộ test | Lệnh | Kết quả |
| --- | --- | --- |
| Vòng đời gói | `npm run test:entitlement` | **16/16** |
| Webhook | `npm run test:webhook` | **9/9** |
| API hồi quy | `npm run test:api-e2e` | **118/118** |
| Flutter | `flutter test` | **22/22** |

Chạy test webhook **phải có khoá**, nếu không nhánh chữ ký đúng bị bỏ qua:

```bash
MOMO_SECRET_KEY=test-momo-secret MOMO_ACCESS_KEY=test-access ZALOPAY_KEY2=test-zalo-key2 npm run start:dev
MOMO_SECRET_KEY=test-momo-secret MOMO_ACCESS_KEY=test-access ZALOPAY_KEY2=test-zalo-key2 npm run test:webhook
```

Khoá phải **giống nhau ở cả hai tiến trình** — backend ký và test ký bằng cùng
một khoá thì chữ ký mới khớp.

### 2.5. Commit

| Hash | Repo | Nội dung |
| --- | --- | --- |
| `55090b1` | BE | Subscription + EntitlementService + hạn mức |
| `f629c08` | BE | Xác thực chữ ký webhook + nối cấp quyền |
| `2dee9db` | App | Paywall + entitlement provider |

---

## 3. Chưa làm — theo thứ tự ưu tiên

### P0 — Khởi tạo thanh toán Momo và ZaloPay

**Vì sao trước hết:** đường về đã thông nhưng đường đi chưa có, nên **hiện tại
không ai trả tiền được**. Đây là mắt xích duy nhất chặn toàn bộ doanh thu.

Hiện `checkout()` (`premium.service.ts:108`) **cố tình ném lỗi**:

```ts
throw new BadRequestException('errors.premium.checkoutNotAvailable');
```

Đó là quyết định có chủ đích từ đợt trước — bản cũ cấp Premium cho bất kỳ ai gọi
tới, chỉ dựa vào một chuỗi `paymentMethod` do client tự khai, không gọi cổng nào.
**Đừng gỡ throw này cho tới khi có tích hợp thật.**

Việc cần làm:

1. Gọi API tạo đơn của Momo (`/v2/gateway/api/create`) và ZaloPay (`/v2/create`).
2. Mã đơn **bắt buộc** theo định dạng `tmsub.<userId>.<plan>.<months>.<timestamp>`
   — đã có helper `PremiumService.buildOrderId()`. Webhook parse ngược từ đây;
   sai định dạng thì `fulfill()` bỏ qua và người dùng trả tiền mà không nhận gì.
3. Với ZaloPay, nhét `orderId` vào `embed_data` (webhook đọc ở đó).
4. Trả `payUrl` / `deeplink` về app, mở bằng `url_launcher`.

Biến môi trường cần thêm: `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`,
`MOMO_SECRET_KEY`, `MOMO_ENDPOINT`, `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`,
`ZALOPAY_KEY2`, `ZALOPAY_ENDPOINT`.

> Chữ ký tạo đơn dùng **KEY1**, chữ ký webhook dùng **KEY2**. Nhầm hai khoá này
> là lỗi phổ biến nhất khi tích hợp ZaloPay.

### P0 — Xác thực biên lai Google Play

**Vì sao ngang hàng P0:** chính sách Google Play bắt buộc hàng hoá số trong app
Android đi qua Play Billing. Bán gói bằng Momo/ZaloPay trong app Android là
**vi phạm chính sách và có thể bị gỡ app**.

Hiện `verifyGooglePlayPurchase()` (`premium.service.ts:123`) ném
`ServiceUnavailableException` — cũng là chặn có chủ đích: không verify thì bất kỳ
client nào cũng gửi token bịa và nhận Premium.

Việc cần làm:

1. Tạo Service Account trên Google Play Developer API, cấp quyền xem đơn hàng.
2. Đặt `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Gọi `purchases.subscriptions.get` để kiểm token.
4. Xác thực xong thì gọi `entitlements.grant(...)` với `provider` phù hợp —
   **cần thêm giá trị vào enum `PaymentProvider`**, hiện chỉ có
   `MOMO / VNPAY / ZALOPAY / BANK_TRANSFER / CASH`, chưa có `GOOGLE_PLAY`.
5. Tạo sản phẩm trên Play Console khớp với `plan`: gói tháng và gói năm cho PLUS,
   gói tháng cho SQUAD.
6. Xử lý webhook Real-time Developer Notifications cho gia hạn và huỷ.

Xem thêm `EXTERNAL_SETUP.md` mục "In-app purchase".

### P1 — Áp hạn mức cho các quota còn lại

Mới chặn `activeTrips`. Ba hạn mức còn lại **đã khai báo nhưng chưa chặn ở đâu**:

| Quota | Chặn ở đâu | Đếm cái gì |
| --- | --- | --- |
| `membersPerTrip` | `invites.service.ts` (chỗ tạo `tripMember`) | `tripMember.count({ tripId })` |
| `momentsPerTrip` | `moments.service.ts` (chỗ tạo moment) | `moment.count({ tripId, deletedAt: null })` |
| `aiPerMonth` | `ai.service.ts` | `aIRequest.count` trong 30 ngày của user |

Mẫu có sẵn ở `trips.service.ts:33-37`. Nhớ `imports: [PremiumModule]` trong
module tương ứng.

**Lưu ý về `membersPerTrip`:** hạn mức phải xét theo **chủ chuyến**, không phải
người đang bấm tham gia — nếu không, một người Free tham gia chuyến của người trả
tiền sẽ bị chặn oan.

### P1 — Soi paywall trên thiết bị

Paywall có **widget test 6/6** nhưng **chưa ai nhìn nó chạy thật trong luồng**.
Tôi thử điều khiển form tạo chuyến qua `adb` nhưng date picker làm luồng chệch
nhiều lần nên chuyển sang widget test.

Cách tái hiện: đăng nhập `demo_tripmate` (đã có 2 chuyến = chạm hạn mức), vào tab
Tạo chuyến, điền tên và ngày, bấm tạo → paywall phải hiện với dòng
*"Bản miễn phí cho 2 chuyến cùng lúc"*.

### P2 — Màn quản lý gói

`subscription_settings_screen.dart` vẫn đọc dữ liệu cũ. Cần nối vào
`entitlementProvider`, hiện hạn dùng thật, và nút huỷ gọi `POST /premium/cancel`.

### P2 — Job hạ gói khi hết hạn

Hiện `status` vẫn là `ACTIVE` sau khi `currentPeriodEnd` trôi qua.
`EntitlementService` xử lý đúng (so sánh với `currentPeriodEnd`, không tin
`status`), nên **không sai về quyền** — nhưng số liệu thống kê sẽ đếm nhầm người
đã hết hạn là đang hoạt động. Cần cron đổi `status` sang `EXPIRED`.

---

## 4. Những điều phải biết trước khi sửa

Đây là phần dễ mất nhất khi đổi người. Đọc kỹ.

### 4.1. Đừng quay lại cách suy ra premium từ `PaymentTransaction`

Bản cũ tìm chuỗi `'ELITE_SQUAD_SUBSCRIPTION'` trong trường `note`. Ba lỗ hổng:
khớp `contains` trên text tự do; **không kiểm hết hạn** nên một lần trả = premium
vĩnh viễn; không có chỗ ghi gia hạn/huỷ. `PaymentTransaction` là bảng **chia tiền
giữa các thành viên trong chuyến** — nó có `expenseId` và `receiverId`, không
phải chỗ cho gói đăng ký.

### 4.2. Mốc hết hạn là `currentPeriodEnd`, không phải `status`

`EntitlementService.of()` luôn so với `currentPeriodEnd`. Nếu sau này thêm job
đổi `status`, **vẫn giữ điều kiện `currentPeriodEnd: { gt: now }`** — tin vào
`status` là quay lại đúng cái bug cũ.

### 4.3. Gia hạn cộng dồn từ thời điểm còn hạn

`grant()` cộng tháng từ `currentPeriodEnd` hiện có, không phải từ hôm nay. Trả
sớm thì không mất những ngày còn lại. Đổi chỗ này là lấy tiền của người dùng.

### 4.4. Huỷ thì giữ quyền tới hết kỳ

`cancel()` chỉ đặt `cancelAtPeriodEnd = true`. Cắt quyền ngay là lấy đi thứ họ đã
trả tiền.

### 4.5. Ghế Squad Pass phải kiểm qua quan hệ

`SquadSeat` chỉ còn giá trị khi gói gốc còn hạn. Truy vấn hiện tại kiểm qua
`subscription: { status, currentPeriodEnd }` — **đừng tối ưu thành đọc riêng bảng
ghế**, vì ghế không tự biết gói mẹ đã hết hạn.

### 4.6. Webhook phải trả nguyên văn

ZaloPay đọc `return_code` ở **gốc** phản hồi. `TransformInterceptor` bọc mọi thứ
trong `{success, data}`, nên webhook có `@RawResponse()`. Gỡ decorator này thì
ZaloPay coi giao dịch thất bại và **gọi lại webhook mãi**.

### 4.7. Chữ ký ZaloPay ký trên chuỗi `data` nguyên văn

Không phải trên object đã parse. Parse rồi `JSON.stringify` lại sẽ đổi thứ tự
khoá và ra chữ ký khác.

### 4.8. So sánh chữ ký bằng `timingSafeEqual`

Không dùng `===`. So bằng `===` lộ độ dài tiền tố khớp qua thời gian chạy, đủ để
dò dần ra chữ ký đúng.

### 4.9. Thiếu khoá thì từ chối, đừng bỏ qua kiểm tra

Cả hai webhook trả 503 khi thiếu khoá cấu hình. Thà không xử lý còn hơn xử lý mà
không kiểm được chữ ký.

### 4.10. Giá đã đổi có căn cứ

99.000đ/tháng cũ **đắt hơn YouTube Premium Việt Nam (79.000đ)** cho một app du
lịch chưa có thói quen dùng hàng ngày. Gen Z Việt chi tổng 100–500k/tháng cho
*tất cả* dịch vụ đăng ký. Nay 39.000đ/tháng, 299.000đ/năm, và Squad Pass
99.000đ/tháng cho 5 người. Muốn đổi giá thì đọc `PRODUCT_STRATEGY.md` mục 3.1
trước.

### 4.11. Free không bao giờ khoá chức năng lõi

Chia tiền, tạo chuyến, đăng ảnh, chat — **không khoá**. Free chỉ giới hạn **quy
mô và tần suất**. Khoá chức năng lõi là mất luôn người dùng, và paywall nói rõ
điều này để họ không tưởng bị lấy mất thứ đang dùng.

---

## 5. Nợ kỹ thuật và rủi ro

| # | Vấn đề | Mức | Ghi chú |
| --- | --- | --- | --- |
| N1 | Dùng `db push`, chưa có migration | Trung bình | Cần `prisma migrate dev` trước khi lên production, nếu không mất lịch sử schema |
| N2 | `PaymentProvider` chưa có `GOOGLE_PLAY` | Cao | Chặn P0 số 2 |
| N3 | Dữ liệu dev bẩn: chuyến seed có **87/115 thành viên là tài khoản `e2e_*`** | Trung bình | BUG-013 trong `qa/QA_BUGS.md`. Mọi số liệu đo trên dev đều lệch. Chưa xoá vì là dữ liệu của người dùng |
| N4 | Chưa có sự kiện phễu trong `Activity` | Trung bình | Không đo được xem paywall → checkout → trả tiền |
| N5 | Widget iOS chưa có target trong Xcode | Thấp | Cần máy macOS |
| N6 | Test webhook cần khoá thủ công | Thấp | Chưa có `.env.test` |

---

## 6. Việc đầu tiên nên làm

1. Đọc mục 4 (những điều phải biết) — **20 phút, tiết kiệm nhiều giờ**.
2. Chạy `npm run test:entitlement` và `npm run test:webhook` để thấy nền hiện tại
   đang chạy đúng.
3. Đọc `entitlement.service.ts` — ngắn, và là trung tâm của mọi thứ.
4. Bắt đầu P0: tích hợp Momo trước (đơn giản hơn ZaloPay ở khâu tạo đơn), dùng
   `buildOrderId()` có sẵn, rồi chạy lại `test:webhook` để chắc đường về vẫn thông.

---

## 7. Liên hệ giữa các tài liệu

| File | Nội dung |
| --- | --- |
| `docs/PRODUCT_AUDIT.md` | Trạng thái toàn hệ thống trước khi làm, nợ kỹ thuật |
| `docs/PRODUCT_STRATEGY.md` | Nghiên cứu thị trường, giá, gamification, lộ trình 5 phase |
| `docs/HANDOVER_MONETIZATION.md` | File này — bàn giao phần thanh toán |
| `qa/QA_BUGS.md` | Sổ lỗi QA, 24 bug với bằng chứng |
| `EXTERNAL_SETUP.md` | Cấu hình dịch vụ ngoài, có mục In-app purchase |
