import { ForbiddenException, Injectable } from '@nestjs/common';
import { Plan } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Những thứ bản Free bị giới hạn. */
export type Quota =
  | 'activeTrips'
  | 'membersPerTrip'
  | 'momentsPerTrip'
  | 'aiPerMonth';

/**
 * Giới hạn của bản Free.
 *
 * Nguyên tắc: **giới hạn quy mô và tần suất, không bao giờ giới hạn chức năng
 * lõi**. Chia tiền, tạo chuyến, đăng ảnh, chat đều không khoá — đó là lý do
 * người dùng ở lại, khoá chúng thì mất luôn người dùng.
 */
export const FREE_LIMITS: Record<Quota, number> = {
  activeTrips: 2,
  membersPerTrip: 8,
  momentsPerTrip: 100,
  aiPerMonth: 15,
};

/** Giới hạn của bản trả tiền. Vẫn có trần để chặn lạm dụng. */
export const PAID_LIMITS: Record<Quota, number> = {
  activeTrips: Number.MAX_SAFE_INTEGER,
  membersPerTrip: 30,
  momentsPerTrip: Number.MAX_SAFE_INTEGER,
  aiPerMonth: 300,
};

export interface Entitlement {
  plan: Plan;
  /** Nguồn quyền: gói của chính mình, hay ghế được squad cấp. */
  via: 'own' | 'seat' | 'none';
  activeUntil: Date | null;
  limits: Record<Quota, number>;
}

/**
 * Trả lời một câu hỏi duy nhất: **người này được dùng những gì**.
 *
 * Trước đây không có chỗ nào trong toàn bộ backend trả lời được câu đó — quét
 * `isPremium`, `premiumUntil`, `PremiumGuard`, `entitle*` đều ra 0 kết quả. Hệ
 * quả là người trả tiền không nhận được gì khác người không trả, và người không
 * trả cũng không bị chặn ở đâu cả.
 */
@Injectable()
export class EntitlementService {
  constructor(private prisma: PrismaService) {}

  /**
   * Quyền hiện tại của một người dùng.
   *
   * Xét theo thứ tự: gói của chính họ trước, rồi mới tới ghế được người khác
   * cấp qua Squad Pass. Hết hạn thì rơi về Free — mốc so sánh duy nhất là
   * `currentPeriodEnd`, không phải sự tồn tại của một giao dịch nào đó.
   */
  async of(userId: string): Promise<Entitlement> {
    const now = new Date();

    const own = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        currentPeriodEnd: { gt: now },
      },
      orderBy: { currentPeriodEnd: 'desc' },
    });
    if (own) {
      return {
        plan: own.plan,
        via: 'own',
        activeUntil: own.currentPeriodEnd,
        limits: PAID_LIMITS,
      };
    }

    // Ghế Squad Pass: người khác trả, mình dùng ké. Ghế chỉ còn giá trị khi gói
    // gốc còn hạn — nên phải kiểm tra qua quan hệ, không tin riêng bảng ghế.
    const seat = await this.prisma.squadSeat.findFirst({
      where: {
        userId,
        revokedAt: null,
        subscription: {
          status: 'ACTIVE',
          currentPeriodEnd: { gt: now },
        },
      },
      include: { subscription: true },
      orderBy: { grantedAt: 'desc' },
    });
    if (seat) {
      return {
        plan: seat.subscription.plan,
        via: 'seat',
        activeUntil: seat.subscription.currentPeriodEnd,
        limits: PAID_LIMITS,
      };
    }

    return {
      plan: 'FREE',
      via: 'none',
      activeUntil: null,
      limits: FREE_LIMITS,
    };
  }

  /** Có đang trả tiền (hoặc dùng ghế) không. */
  async isPaid(userId: string): Promise<boolean> {
    return (await this.of(userId)).via !== 'none';
  }

  /**
   * Chặn khi vượt giới hạn.
   *
   * Ném `ForbiddenException` kèm mã máy đọc được để client biết **đúng thứ vừa
   * bị chặn** mà mở paywall nói trúng chuyện đó — thay vì một popup quảng cáo
   * chung chung.
   */
  async assertWithin(
    userId: string,
    quota: Quota,
    current: number,
  ): Promise<void> {
    const ent = await this.of(userId);
    const limit = ent.limits[quota];
    if (current < limit) return;

    throw new ForbiddenException({
      code: 'QUOTA_EXCEEDED',
      quota,
      limit,
      current,
      plan: ent.plan,
    });
  }

  /**
   * Cấp hoặc gia hạn gói sau khi thanh toán thành công.
   *
   * Gia hạn cộng dồn từ **thời điểm còn hạn**, không phải từ hôm nay: trả sớm
   * thì không bị mất những ngày còn lại.
   *
   * `externalId` đi cùng ràng buộc `@@unique([provider, externalId])` ở tầng
   * database, nên cổng thanh toán có gọi lại webhook nhiều lần cũng không cấp
   * trùng kỳ.
   */
  async grant(params: {
    userId: string;
    plan: Exclude<Plan, 'FREE'>;
    months: number;
    provider: 'MOMO' | 'ZALOPAY' | 'BANK_TRANSFER' | 'CASH' | 'VNPAY';
    externalId?: string;
  }) {
    const { userId, plan, months, provider, externalId } = params;
    const now = new Date();

    const existing = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE', currentPeriodEnd: { gt: now } },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    const base = existing?.currentPeriodEnd ?? now;
    const end = new Date(base);
    end.setMonth(end.getMonth() + months);

    if (existing) {
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          plan,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          canceledAt: null,
        },
      });
    }

    return this.prisma.subscription.create({
      data: {
        userId,
        plan,
        provider,
        externalId,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        seats: plan === 'SQUAD' ? 5 : 1,
      },
    });
  }

  /**
   * Huỷ gia hạn.
   *
   * Giữ quyền tới hết kỳ đã trả tiền — cắt ngay là lấy của người dùng thứ họ
   * đã mua.
   */
  async cancel(userId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { currentPeriodEnd: 'desc' },
    });
    if (!sub) return null;
    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
    });
  }
}
