import { PaidPlan, PLAN_PRICE } from './pricing';

/**
 * Danh mục sản phẩm bán trên Google Play — **nguồn sự thật duy nhất** cho ánh
 * xạ mã sản phẩm sang (gói, số tháng).
 *
 * Trước đây `verifyGooglePlayPurchase` đoán gói bằng `productId.includes()`:
 * chuỗi `tripmate_squad_yearly` khớp nhánh `'squad'` TRƯỚC nhánh `'yearly'`,
 * nên người mua gói năm được cấp đúng **một tháng**. Khách trả 950.000đ và
 * mất 11 tháng — đúng loại lỗi không ai báo vì nạn nhân không biết mình mất gì.
 *
 * Bảng tra cứu tường minh thì không có thứ tự nào để đoán sai.
 *
 * Mã ở đây phải **khớp từng ký tự** với mã sản phẩm khai trong Play Console.
 * Sai một ký tự thì Google trả lỗi khi xác thực chứ không cấp nhầm.
 */
export interface PlayProduct {
  plan: PaidPlan;
  months: number;
}

export const PLAY_PRODUCTS: Record<string, PlayProduct> = {
  tripmate_plus_monthly: { plan: 'PLUS', months: 1 },
  tripmate_plus_yearly: { plan: 'PLUS', months: 12 },
  tripmate_squad_monthly: { plan: 'SQUAD', months: 1 },
  tripmate_squad_yearly: { plan: 'SQUAD', months: 12 },
};

export function playProductOf(productId: unknown): PlayProduct | null {
  if (typeof productId !== 'string') return null;
  return PLAY_PRODUCTS[productId] ?? null;
}

/** Mã sản phẩm Play tương ứng một (gói, kỳ hạn). Dùng để client biết mua gì. */
export function playProductIdFor(
  plan: PaidPlan,
  months: number,
): string | null {
  for (const [id, p] of Object.entries(PLAY_PRODUCTS)) {
    if (p.plan === plan && p.months === months) return id;
  }
  return null;
}

/**
 * Mọi sản phẩm Play phải có giá tương ứng trong bảng giá của server.
 *
 * Giá thật do Google giữ (người dùng trả qua Play), nhưng nếu một kỳ hạn tồn
 * tại ở đây mà không có trong `PLAN_PRICE` thì hai kênh bán đang lệch nhau —
 * kênh SePay không bán được thứ kênh Play đang bán. Ném ngay lúc nạp module để
 * không phát hiện ra lúc khách đã trả tiền.
 */
for (const [id, p] of Object.entries(PLAY_PRODUCTS)) {
  if (PLAN_PRICE[p.plan]?.[p.months] === undefined) {
    throw new Error(
      `Sản phẩm Play "${id}" trỏ tới kỳ hạn ${p.plan}/${p.months} tháng không có trong PLAN_PRICE`,
    );
  }
}
