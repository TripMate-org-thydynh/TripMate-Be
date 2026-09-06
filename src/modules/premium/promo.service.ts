import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Plan, PromoCode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaidPlan } from './pricing';

export interface AppliedPromo {
  code: string;
  description: string;
  /** Số tiền được giảm, đã làm tròn về bội số 1.000đ. */
  discount: number;
  /** Giá sau khi giảm. */
  total: number;
}

/**
 * Mã giảm giá.
 *
 * Bản trước là một object literal ba dòng trong `PremiumService`, và
 * `validatePromoCode` trả về `discount` rồi **không nơi nào dùng tới** — nghĩa
 * là người dùng nhập mã, thấy báo "hợp lệ, giảm 50%", rồi trả nguyên giá. Sửa
 * mã hay đổi khuyến mãi phải sửa mã nguồn và triển khai lại; không có hạn
 * dùng, không có giới hạn số lần.
 */
@Injectable()
export class PromoService {
  private readonly logger = new Logger(PromoService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Tìm mã còn hiệu lực cho người này và gói này.
   *
   * Trả `null` khi không dùng được, kèm lý do qua ngoại lệ khi được yêu cầu
   * nói rõ — hai nhu cầu khác nhau: lúc người dùng bấm "áp dụng" thì cần biết
   * vì sao hỏng, còn lúc tạo đơn thì chỉ cần biết có hay không.
   */
  async validate(
    code: string,
    opts: { userId?: string; plan?: PaidPlan; amount?: number } = {},
  ): Promise<AppliedPromo> {
    const normalized = (code ?? '').trim().toUpperCase();
    if (!normalized) {
      throw new BadRequestException({
        code: 'PROMO_REQUIRED',
        message: 'errors.promo.required',
      });
    }

    const promo = await this.prisma.promoCode.findUnique({
      where: { code: normalized },
    });
    if (!promo || !promo.isActive) {
      throw new BadRequestException({
        code: 'PROMO_NOT_FOUND',
        message: 'errors.promo.notFound',
      });
    }

    const now = new Date();
    if (promo.validFrom > now) {
      throw new BadRequestException({
        code: 'PROMO_NOT_STARTED',
        message: 'errors.promo.notStarted',
      });
    }
    if (promo.validUntil && promo.validUntil < now) {
      throw new BadRequestException({
        code: 'PROMO_EXPIRED',
        message: 'errors.promo.expired',
      });
    }

    if (
      opts.plan &&
      promo.appliesToPlans.length > 0 &&
      !promo.appliesToPlans.includes(opts.plan)
    ) {
      throw new BadRequestException({
        code: 'PROMO_WRONG_PLAN',
        message: 'errors.promo.wrongPlan',
        appliesTo: promo.appliesToPlans,
      });
    }

    // Đếm lượt đã dùng từ bảng `PromoRedemption`, không từ một cột đếm.
    //
    // Cột đếm phải tăng bằng một lệnh riêng và sẽ lệch khỏi sự thật ngay lần
    // đầu có một giao dịch hỏng giữa chừng. Đếm từ bảng thì luôn đúng, và ở
    // quy mô khuyến mãi thì rẻ.
    if (promo.maxRedemptions !== null) {
      const used = await this.prisma.promoRedemption.count({
        where: { codeId: promo.id },
      });
      if (used >= promo.maxRedemptions) {
        throw new BadRequestException({
          code: 'PROMO_EXHAUSTED',
          message: 'errors.promo.exhausted',
        });
      }
    }

    if (opts.userId) {
      const mine = await this.prisma.promoRedemption.count({
        where: { codeId: promo.id, userId: opts.userId },
      });
      if (mine >= promo.perUserLimit) {
        throw new BadRequestException({
          code: 'PROMO_ALREADY_USED',
          message: 'errors.promo.alreadyUsed',
        });
      }
    }

    const amount = opts.amount ?? 0;
    return {
      code: promo.code,
      description: promo.description,
      discount: this.discountFor(promo, amount),
      total: Math.max(0, amount - this.discountFor(promo, amount)),
    };
  }

  /**
   * Số tiền được giảm cho một mức giá.
   *
   * Làm tròn xuống bội số 1.000đ giống bảng giá, và **không bao giờ vượt quá
   * chính số tiền phải trả** — giảm quá tay thành số âm là một đơn hàng mà
   * cổng thanh toán sẽ từ chối, hoặc tệ hơn là chấp nhận.
   */
  private discountFor(promo: PromoCode, amount: number): number {
    if (amount <= 0) return 0;

    let raw = 0;
    if (promo.discountPercent) {
      raw = amount * Number(promo.discountPercent);
    } else if (promo.discountAmount) {
      raw = Number(promo.discountAmount);
    }

    const rounded = Math.round(raw / 1000) * 1000;
    return Math.max(0, Math.min(rounded, amount));
  }

  /**
   * Ghi nhận một lượt dùng — gọi khi đơn đã thanh toán THÀNH CÔNG.
   *
   * Cố ý không ghi lúc tạo đơn: tính lượt ngay lúc đó thì mọi đơn bị bỏ giữa
   * chừng đều đốt một suất, và một người bấm mua rồi thoát vài lần là tự khoá
   * mình khỏi mã của chính mình.
   *
   * `orderId` là `@unique` nên webhook gọi lại nhiều lần cũng chỉ ghi một lượt.
   */
  async redeem(params: {
    code: string;
    userId: string;
    orderId: string;
    discountApplied: number;
  }) {
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: params.code.toUpperCase() },
    });
    if (!promo) {
      this.logger.warn(`Đơn ${params.orderId} mang mã lạ "${params.code}"`);
      return;
    }
    try {
      await this.prisma.promoRedemption.create({
        data: {
          codeId: promo.id,
          userId: params.userId,
          orderId: params.orderId,
          discountApplied: params.discountApplied,
        },
      });
    } catch {
      // `@unique(orderId)`: webhook gọi lại. Không phải lỗi.
      this.logger.log(`Lượt dùng mã của đơn ${params.orderId} đã được ghi`);
    }
  }

  /** Các mã đang chạy, để màn khuyến mãi hiện thay vì để người dùng đoán. */
  async listActive() {
    const now = new Date();
    const rows = await this.prisma.promoCode.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
      },
      orderBy: { validUntil: 'asc' },
    });
    return rows.map((p) => ({
      code: p.code,
      description: p.description,
      discountPercent: p.discountPercent ? Number(p.discountPercent) : null,
      discountAmount: p.discountAmount ? Number(p.discountAmount) : null,
      appliesToPlans: p.appliesToPlans,
      validUntil: p.validUntil,
    }));
  }
}
