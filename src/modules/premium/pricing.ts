import { Plan } from '@prisma/client';

/** Gói bán được. `FREE` không mua được nên không nằm ở đây. */
export type PaidPlan = Exclude<Plan, 'FREE'>;

/**
 * Bảng giá — **nguồn duy nhất**, đặt ở server.
 *
 * Trước đây con số 39.000/99.000 nằm rải trong `premium.service.ts` (để trả về
 * cho màn cài đặt) và trong UI, còn `fulfill()` thì không hề biết giá là bao
 * nhiêu. Hệ quả: webhook cấp gói mà không đối chiếu được số tiền thực trả.
 *
 * Đơn vị VND, tính theo tháng. Mốc tham chiếu của người dùng Việt là YouTube
 * Premium 79.000đ, nên gói cá nhân phải nằm dưới nó.
 */
export const MONTHLY_PRICE: Record<PaidPlan, number> = {
  PLUS: 39000,
  SQUAD: 99000,
};

/** Số ghế đi kèm mỗi gói. Gói cá nhân luôn là 1. */
export const PLAN_SEATS: Record<PaidPlan, number> = {
  PLUS: 1,
  SQUAD: 5,
};

/** Kỳ hạn bán được, kèm mức giảm khi trả trước nhiều tháng. */
export const BILLING_TERMS: { months: number; discount: number }[] = [
  { months: 1, discount: 0 },
  { months: 12, discount: 0.2 },
];

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === 'PLUS' || value === 'SQUAD';
}

/**
 * Giá phải trả cho `plan` trong `months` tháng.
 *
 * Làm tròn tới 1.000đ vì các ví Việt Nam không nhận số lẻ dưới đó, và vì hoá
 * đơn lẻ tới hàng đơn vị trông như lỗi.
 */
export function priceOf(plan: PaidPlan, months: number): number {
  const term = BILLING_TERMS.find((t) => t.months === months);
  if (!term) {
    throw new Error(`Kỳ hạn không bán: ${months} tháng`);
  }
  const gross = MONTHLY_PRICE[plan] * months;
  return Math.round((gross * (1 - term.discount)) / 1000) * 1000;
}

/** Các kỳ hạn hợp lệ, dùng để kiểm tra đầu vào. */
export const SELLABLE_MONTHS = BILLING_TERMS.map((t) => t.months);
