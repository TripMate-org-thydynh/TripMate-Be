# Kế hoạch — Web quản trị TripMate

Cập nhật: 2026-09-05 · Dựa trên [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md), [PRODUCT_STRATEGY.md](PRODUCT_STRATEGY.md), [HANDOVER_MONETIZATION.md](HANDOVER_MONETIZATION.md)

---

## 1. Điểm xuất phát — không dựng từ đầu

Repo `TripMate_web` **đã tồn tại và đã chạy thật**, không phải khung rỗng:

| Hạng mục | Hiện trạng |
| --- | --- |
| Nền tảng | Next.js (App Router) + TypeScript + Tailwind + lucide-react |
| Repo | `github.com/TripMate-org-thydynh/Tripmate-website` — mới **1 commit** |
| Trang admin | **11 trang**: dashboard, users, trips, revenue, growth, ai, reservations, journal, packing, configs, login |
| Gọi API | Server Actions → backend thật qua `fetchWithAuth`, token trong cookie |
| Đã có sẵn | Phân trang, tìm kiếm, lọc, xuất CSV, `ErrorState`, `EmptyState`, đổi sáng/tối |
| Bảo vệ | Backend có `AdminGuard` + `JwtAuthGuard` trên toàn bộ `/admin/*` |

Backend đã mở **21 endpoint admin**: `stats`, `analytics/growth|revenue|ai`,
CRUD cho users / trips / reservations / journals / packing-items, và `configs`.

**Kết luận:** việc cần làm là **lấp khoảng trống và làm cho dùng được thật**,
không phải viết lại.

---

## 2. Khoảng trống lớn nhất — và vì sao nó quan trọng nhất

### 2.1. Không có chỗ nào quản lý gói đăng ký

Vừa xây xong `Subscription`, `SquadSeat`, `EntitlementService` ở backend
(commit `55090b1`, `f629c08`), nhưng:

- **Không có endpoint admin nào** cho subscription.
- **Không có trang nào** để xem ai đang trả tiền, gói gì, hết hạn khi nào.
- `analytics/revenue` đang đọc từ `paymentTransaction` — **bảng chia tiền giữa
  các thành viên trong chuyến**, không phải doanh thu gói. Nghĩa là con số doanh
  thu trên trang admin hiện tại **đang đếm nhầm tiền người dùng trả cho nhau**.

Đây là lỗi nghiêm trọng nhất: người vận hành nhìn vào một con số sai mà tưởng là
doanh thu.

### 2.2. Không có công cụ xử lý sự cố thanh toán

Khi người dùng trả tiền mà webhook lỗi, hoặc đòi hoàn tiền, hiện **không có cách
nào** ngoài vào thẳng database. Đó là việc sẽ xảy ra ngay tuần đầu bán gói.

### 2.3. Không đo được phễu chuyển đổi

`PRODUCT_STRATEGY.md` mục 7 đặt North Star là *số squad có ≥3 thành viên hoạt
động trong 7 ngày*, và cần đo phễu xem paywall → bắt đầu thanh toán → trả tiền.
Chưa có sự kiện nào cho việc đó, nên cũng chưa có gì để hiển thị.

---

## 3. Lộ trình

Ưu tiên theo: **rủi ro vận hành × giá trị cho người vận hành ÷ công sức**.

### Phase A — Sửa số liệu sai và quản lý gói (P0)

> Vì sao trước hết: con số doanh thu đang sai, và sắp có người trả tiền thật.

#### A1. Sửa nguồn dữ liệu doanh thu

**Backend** — `admin.service.ts`:

```ts
// Doanh thu gói = từ bảng Subscription, KHÔNG phải paymentTransaction
// (bảng đó là tiền các thành viên chuyển cho nhau trong chuyến).
```

| Việc | Chi tiết |
| --- | --- |
| Sửa | `getRevenueAnalytics()` đọc từ `subscription`, không phải `paymentTransaction` |
| Thêm chỉ số | MRR, số gói đang hoạt động theo `plan`, số huỷ trong kỳ, doanh thu theo `provider` |
| Giữ lại | Thống kê `paymentTransaction` nhưng **đổi nhãn** thành "Giao dịch chia tiền trong chuyến" — nó vẫn là thông tin hữu ích, chỉ là không phải doanh thu |

**Acceptance:** trang `/admin/revenue` hiện MRR khớp với tổng gói đang hoạt động
đếm tay từ database.

#### A2. Endpoint admin cho subscription

| Endpoint | Việc |
| --- | --- |
| `GET /admin/subscriptions` | Danh sách, lọc theo `plan` / `status` / sắp hết hạn |
| `GET /admin/subscriptions/:id` | Chi tiết + danh sách ghế Squad |
| `POST /admin/subscriptions/:id/extend` | Gia hạn thủ công (xử lý sự cố) |
| `POST /admin/subscriptions/:id/revoke` | Thu hồi (hoàn tiền, gian lận) |

**Bắt buộc:** mọi thao tác ghi phải ghi log ai làm, lúc nào, lý do. Cấp quyền thủ
công là đường dễ bị lạm dụng nhất trong hệ thống trả phí.

#### A3. Trang `/admin/subscriptions`

| Thành phần | Nội dung |
| --- | --- |
| Bảng | Người dùng · gói · trạng thái · hết hạn · nguồn thanh toán · số ghế |
| Lọc | Gói, trạng thái, "hết hạn trong 7 ngày" |
| Chi tiết | Lịch sử kỳ, ghế Squad đang cấp cho ai |
| Thao tác | Gia hạn / thu hồi, **có hộp nhập lý do bắt buộc** |

**Acceptance:** tạo một gói test qua `test:entitlement`, trang phải hiện đúng
người, đúng hạn, và thu hồi được.

---

### Phase B — Vận hành hằng ngày (P1)

#### B1. Trang xử lý sự cố thanh toán

Người dùng báo "đã trả tiền mà không lên gói" là ca **chắc chắn xảy ra**. Cần:

- Tra cứu theo mã đơn `tmsub.<userId>.<plan>.<months>.<timestamp>` hoặc mã giao
  dịch của cổng.
- Xem webhook đã nhận chưa, chữ ký đúng không, `fulfill()` có chạy không.
- Nút "cấp quyền thủ công" kèm lý do.

Phụ thuộc: cần backend **lưu nhật ký webhook** (hiện chỉ ghi `logger`, mất khi
restart). Thêm bảng `WebhookLog {provider, externalId, payload, verified, result, createdAt}`.

#### B2. Bảng điều khiển North Star

Theo `PRODUCT_STRATEGY.md` mục 7:

| Nhóm | Chỉ số |
| --- | --- |
| **North Star** | Số squad có ≥3 thành viên hoạt động trong 7 ngày |
| Kích hoạt | % tạo chuyến ngày đầu · % mời được ≥1 người |
| Gắn kết | DAU/MAU · ảnh mỗi chuyến |
| Giữ chân | D1 / D7 / D30 |
| Doanh thu | MRR · ARPU · tỉ lệ Squad Pass |

Nguồn: `Activity` (19 loại, đã có index theo `userId` và `tripId`) — **đã là một
event log**, chỉ cần truy vấn tổng hợp, không cần dựng hạ tầng mới.

#### B3. Dọn dữ liệu test

Chuyến seed có **87/115 thành viên là tài khoản `e2e_*`** (BUG-013). Cần trang
lọc và xoá hàng loạt tài khoản test, **có xác nhận hai bước** — đây là thao tác
xoá dữ liệu người dùng.

---

### Phase C — Phễu và CRM (P2)

#### C1. Sự kiện phễu

Mở rộng `Activity` cho các sự kiện ngoài phạm vi chuyến:
`PAYWALL_VIEWED`, `CHECKOUT_STARTED`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`,
`SUBSCRIPTION_CANCELED`.

Lưu ý: `Activity.tripId` hiện **bắt buộc**. Các sự kiện này không thuộc chuyến
nào → phải cho `tripId` nullable, hoặc tách bảng `UserEvent` riêng. **Chọn tách
bảng**: `Activity` đang được dùng cho feed trong chuyến, thêm bản ghi không có
`tripId` sẽ làm bẩn feed đó.

#### C2. Phân khúc người dùng

Theo `PRODUCT_STRATEGY.md` mục 6: Người mới / Khám phá / Người lên kế hoạch / Đi
thường xuyên / Dùng nhiều / Nguội / Nguy cơ rời bỏ / Đã trả tiền.

Trang xem số lượng từng nhóm và xuất danh sách để gửi thông báo.

#### C3. Quản lý nội dung

Kiểm duyệt moment bị báo cáo, khoá tài khoản vi phạm. Chưa gấp vì chưa có người
dùng thật, nhưng cần trước khi mở công khai.

---

### Phase D — Hoàn thiện chất lượng (P2)

| Việc | Vì sao |
| --- | --- |
| **Kiểm tra tự động** | Repo web hiện **không có test nào**. Tối thiểu: smoke test cho mỗi trang admin, test cho `fetchWithAuth` |
| **Chặn phía client** | Hiện chỉ backend có `AdminGuard`. Web cần middleware chuyển hướng khi chưa đăng nhập, thay vì để trang trắng |
| **Xử lý hết phiên** | Token trong cookie hết hạn → hiện chưa rõ điều gì xảy ra |
| **i18n** | App đã có vi/en 1472 khoá. Web hiện chỉ tiếng Việt — quyết định có cần song ngữ không |
| **Nhật ký thao tác admin** | Ai sửa gì, lúc nào. Bắt buộc khi có nhiều người vận hành |

---

## 4. Bảng ưu tiên tổng hợp

| # | Việc | Phase | Ưu tiên | Lý do |
| --- | --- | --- | --- | --- |
| 1 | Sửa nguồn doanh thu | A1 | **P0** | Số liệu đang **sai**, người vận hành ra quyết định dựa vào nó |
| 2 | Endpoint + trang subscription | A2, A3 | **P0** | Sắp có người trả tiền, chưa có chỗ nào quản lý |
| 3 | Nhật ký webhook + xử lý sự cố | B1 | **P1** | Sự cố thanh toán chắc chắn xảy ra tuần đầu |
| 4 | Bảng điều khiển North Star | B2 | **P1** | Không đo thì không biết có đang tăng trưởng không |
| 5 | Dọn tài khoản test | B3 | **P1** | Mọi số liệu dev đang lệch |
| 6 | Sự kiện phễu | C1 | **P2** | Cần trước khi tối ưu chuyển đổi |
| 7 | Phân khúc người dùng | C2 | **P2** | Nền cho CRM |
| 8 | Test + middleware + nhật ký admin | D | **P2** | Nợ chất lượng, tăng dần theo số người vận hành |

---

## 5. Những điều phải biết khi làm

### 5.1. `paymentTransaction` không phải doanh thu

Bảng đó ghi **tiền các thành viên chuyển cho nhau trong chuyến** (có `expenseId`,
`receiverId`). Doanh thu gói nằm ở `Subscription`. Nhầm hai thứ này chính là lỗi
đang có trên trang revenue.

### 5.2. Trạng thái gói xét theo `currentPeriodEnd`

Không tin `status`. Chưa có job hạ gói khi hết hạn, nên `status` vẫn `ACTIVE` sau
khi hết hạn. `EntitlementService` xử lý đúng, nhưng **truy vấn thống kê phải tự
lọc theo `currentPeriodEnd`**, nếu không sẽ đếm người đã hết hạn là đang hoạt động.

### 5.3. Cấp quyền thủ công phải có vết

Mọi `extend` / `revoke` từ admin đều ghi ai làm và lý do. Đây là đường dễ lạm
dụng nhất.

### 5.4. Web dùng Server Actions, không phải API route

Xem `src/app/actions.ts`. Token đọc từ cookie qua `getAuthToken()`. Giữ nguyên
cách này, đừng trộn thêm client-side fetch.

### 5.5. Backend đã có `AdminGuard`

Không cần tự kiểm quyền trong từng trang web. Nhưng vẫn cần middleware để chuyển
hướng người chưa đăng nhập — hiện họ sẽ thấy trang lỗi thay vì màn đăng nhập.

---

## 6. Việc đầu tiên nên làm

1. Chạy `npm run dev` trong `TripMate_web`, đăng nhập bằng tài khoản admin, mở
   `/admin/revenue` — **nhìn con số sai tận mắt** trước khi sửa.
2. Sửa `getRevenueAnalytics()` đọc từ `subscription` (A1).
3. Thêm `GET /admin/subscriptions` (A2), rồi dựng trang (A3) theo đúng mẫu
   `/admin/users` đã có — nó đã có phân trang, lọc, xuất CSV, error/empty state.
4. Chạy `npm run test:entitlement` để tạo dữ liệu gói thật, rồi kiểm trang mới
   hiện đúng.
