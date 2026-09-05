# TripMate — Audit sản phẩm trước khi làm monetization & gamification

Ngày: 2026-09-04 · Phạm vi: toàn bộ `TripMate_app` (Flutter) + `TripMate_be` (NestJS + Prisma/PostgreSQL)

---

## 0. Quy mô hệ thống

| Hạng mục | Số lượng |
| --- | --- |
| File Dart | 193 (~56.800 dòng) |
| File TypeScript | 167 (~13.400 dòng) |
| Module backend | 30 |
| Feature app | 24 |
| Model database | 44 |
| Endpoint API | 199 |

Đây **không phải** dự án mới bắt đầu. Phần lớn hạ tầng CRUD đã chạy thật và đã
được kiểm chứng E2E ở các đợt trước (118/118). Việc cần làm là **gắn lớp kiếm
tiền và giữ chân lên một sản phẩm đã có**, không phải dựng lại từ đầu.

---

## 1. Phát hiện chặn đường — phải xử lý trước mọi thứ khác

### 1.1. Không có thực thể subscription. Trạng thái premium suy ra từ chuỗi ghi chú

`PremiumService.getSubscriptions()` xác định người dùng có premium hay không
bằng cách **tìm chuỗi `'ELITE_SQUAD_SUBSCRIPTION'` trong trường `note`** của
bảng `PaymentTransaction`:

```ts
const subscriptionTx = await this.prisma.paymentTransaction.findFirst({
  where: { senderId: userId, status: 'SUCCESS',
           note: { contains: 'ELITE_SQUAD_SUBSCRIPTION' } },
  orderBy: { createdAt: 'desc' },
});
if (subscriptionTx) return { tier: 'ELITE_SQUAD', status: 'ACTIVE', ... };
```

Hệ quả, theo mức độ nghiêm trọng:

| # | Vấn đề | Hệ quả |
| --- | --- | --- |
| 1 | Trả về `status: 'ACTIVE'` **không hề kiểm tra hết hạn** | Một giao dịch thành công **một lần** = premium **vĩnh viễn**. `nextBillingDate` có được tính nhưng không ai dùng để so sánh |
| 2 | Dùng nhầm bảng | `PaymentTransaction` sinh ra để ghi **chuyển tiền giữa các thành viên trong chuyến** — nó có `expenseId`, `receiverId`. Mua gói thì `receiverId` trỏ vào ai? |
| 3 | Khớp bằng `contains` trên text tự do | Bất kỳ giao dịch nào có ghi chú chứa chuỗi đó đều thành premium |
| 4 | Không có gia hạn, huỷ, hoàn tiền, hạ gói | Không có nơi nào lưu vòng đời |

### 1.2. Không có một chỗ nào kiểm tra quyền premium

Quét toàn backend: `isPremium`, `premiumUntil`, `PremiumGuard`, `entitle*` →
**0 kết quả**. Model `User` **không có trường nào** về gói, hạn dùng, hay tier.

Nghĩa là hiện tại:

- Người **trả tiền** không nhận được gì khác người không trả.
- Người **không trả tiền** không bị chặn ở bất kỳ đâu.

Có `POST /premium/checkout`, có webhook Momo/ZaloPay, có màn thanh toán trong
app — nhưng **toàn bộ chuỗi đó không dẫn tới một thay đổi trạng thái nào**. Đây
là lỗ hổng gốc, và mọi thứ về monetization đều phải xếp sau việc sửa nó.

---

## 2. Đã có và dùng được — nền để xây tiếp

### 2.1. Hệ XP: thật, không phải trang trí

`XpService` là phần **đã làm tử tế nhất** cho gamification:

- `XpLedger` ghi từng lần cộng/trừ → có thể truy vết, không phải một con số trần trụi.
- `EARN_RULES` có **hạn mức theo ngày** cho từng loại — chống cày điểm.
- Chi tiêu qua `spend()` trong transaction, có `xpBalance` (tiêu được) tách khỏi
  `xpEarned` (tổng đời, dùng tính cấp) — đúng cách.
- `XP_PER_LEVEL = 500`, `levelOf()` / `levelProgress()` đã có.
- Cửa hàng sticker và theme đã mua bán được bằng XP (`store.service.ts`).

Nguồn cộng XP hiện tại đi qua `ActivityService` với 7 loại hoạt động:
`MOMENT_SHARED`, `EXPENSE_ADDED`, `ITINERARY_ADDED`, `NOTE_ADDED`,
`JOURNAL_WRITTEN`, `POLL_CREATED`, `DOCUMENT_UPLOADED`.

### 2.2. `Activity` — nền phân tích đã có sẵn mà chưa khai thác

Model `Activity` ghi `{tripId, userId, type, data: Json, createdAt}` với **19
loại** hoạt động, có index theo `tripId` và `userId`.

Đây **đã là một event log**. Không cần dựng hạ tầng analytics mới từ đầu — chỉ
cần mở rộng nó cho các sự kiện ngoài phạm vi chuyến (mở app, xem paywall, bắt
đầu checkout…) và thêm truy vấn tổng hợp.

### 2.3. Hạ tầng khác dùng lại được

| Thành phần | Trạng thái |
| --- | --- |
| Auth (username/password + OTP), JWT | Chạy thật |
| Trips / Itinerary / Expenses / Moments / Chat / Polls | Chạy thật, E2E 118/118 |
| Thanh toán Momo + ZaloPay + Google Play Billing | Có endpoint và webhook, **thiếu khâu cấp quyền** |
| Cửa hàng sticker/theme bằng XP | Chạy thật |
| Widget màn hình chính + màn xem khoảnh khắc + thả cảm xúc | Vừa làm, đã nghiệm thu |
| Recap "Trip Wrapped" | Vừa làm, đã nghiệm thu |
| i18n vi/en | 1472/1472 khoá, cân bằng |

---

## 3. Còn thiếu hoàn toàn

Quét `prisma/schema.prisma` cho `streak`, `quest`, `badge`, `achievement`,
`leaderboard` → **không có model nào**.

| Nhóm | Thiếu gì |
| --- | --- |
| **Giữ chân** | Streak (chuỗi ngày), quest ngày/tuần, nhiệm vụ chuyến đi |
| **Thành tựu** | Badge / achievement, hộ chiếu du lịch, bộ sưu tập, hoàn thành tỉnh/thành |
| **Xã hội** | Bảng xếp hạng, thách đấu giữa các squad |
| **Kiếm tiền** | Bảng `Subscription`, cấp quyền, hạn mức gói free, tín dụng AI, paywall |
| **Phân tích** | Không có Amplitude/Mixpanel/PostHog/Firebase; chỉ có `admin.service` với vài truy vấn tổng hợp |
| **CRM** | Không có phân khúc người dùng, không có automation vòng đời |

---

## 4. Nợ kỹ thuật ảnh hưởng trực tiếp tới việc sắp làm

| # | Nợ | Vì sao chặn |
| --- | --- | --- |
| N1 | `PaymentTransaction` gánh hai vai: chia tiền trong chuyến **và** mua gói | Không tách thì không thể làm gia hạn/huỷ/hoàn tiền cho gói |
| N2 | Không có `Subscription` / `Entitlement` | Không có nơi để hỏi "người này được dùng gì" |
| N3 | Chưa có hạn mức cho tài khoản free | Không có gì để bán, vì free đã dùng được mọi thứ |
| N4 | Chưa có sự kiện ngoài phạm vi chuyến trong `Activity` | Không đo được phễu chuyển đổi (xem paywall → checkout → trả tiền) |
| N5 | Dữ liệu dev bẩn: chuyến seed có **87/115 thành viên là tài khoản `e2e_*`** (BUG-013) | Mọi số liệu đo trên môi trường dev đều lệch |
| N6 | Widget iOS chưa có target trong Xcode | Tính năng widget mới chỉ chạy Android |

---

## 5. Kết luận của bước audit

Sản phẩm **đã có phần khó**: dữ liệu thật, luồng nghiệp vụ chạy được, XP có
ledger tử tế, và một event log sẵn sàng để phân tích.

Thứ chưa có là **lớp thương mại**: không có thực thể gói, không có cấp quyền,
không có giới hạn cho bản free. Vì vậy thứ tự bắt buộc là:

1. **Sửa nền monetization trước** (Subscription + Entitlement + giới hạn free).
   Không có bước này thì mọi paywall đều là trang trí.
2. **Rồi mới tới gamification giữ chân** (streak, quest, badge) — chúng dựa vào
   `XpLedger` và `Activity` vốn đã có.
3. **Rồi tới CRM và phân tích**, dùng `Activity` mở rộng làm nguồn.

Bước tiếp theo: nghiên cứu thị trường và hành vi Gen Z để chốt *bán cái gì* và
*giá bao nhiêu*, trước khi viết dòng code đầu tiên.
