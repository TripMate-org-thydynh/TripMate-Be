import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ActivityType, Prisma, XpReason } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Số XP cần cho mỗi cấp. Trùng với thang XP của squad để người dùng khỏi phải
 * nhớ hai hệ số khác nhau. */
export const XP_PER_LEVEL = 500;

/**
 * Quy tắc kiếm XP.
 *
 * `dailyCap` là số LẦN được thưởng mỗi ngày cho mỗi loại, không phải số XP.
 * Không có nó thì người dùng cày vô hạn bằng cách thêm–xoá khoản chi liên tục:
 * mỗi lần thêm sinh một thực thể mới nên `refId` chống trùng không chặn được.
 */
const EARN_RULES: Record<XpReason, { amount: number; dailyCap: number }> = {
  MOMENT_SHARED: { amount: 40, dailyCap: 5 },
  EXPENSE_ADDED: { amount: 20, dailyCap: 5 },
  ITINERARY_ADDED: { amount: 30, dailyCap: 5 },
  NOTE_ADDED: { amount: 15, dailyCap: 5 },
  JOURNAL_WRITTEN: { amount: 25, dailyCap: 3 },
  POLL_CREATED: { amount: 20, dailyCap: 3 },
  DOCUMENT_UPLOADED: { amount: 15, dailyCap: 3 },
  GAME_PLAYED: { amount: 50, dailyCap: 10 },
  // Ba loại dưới là chiều tiêu / chỉnh tay, không áp trần ngày.
  STICKER_PURCHASE: { amount: 0, dailyCap: 0 },
  THEME_PURCHASE: { amount: 0, dailyCap: 0 },
  ADMIN_ADJUST: { amount: 0, dailyCap: 0 },
};

/** Hoạt động nào sinh ra XP. Loại không có trong bảng này thì không thưởng. */
const ACTIVITY_TO_REASON: Partial<Record<ActivityType, XpReason>> = {
  MOMENT_SHARED: 'MOMENT_SHARED',
  EXPENSE_ADDED: 'EXPENSE_ADDED',
  ITINERARY_ADDED: 'ITINERARY_ADDED',
  NOTE_ADDED: 'NOTE_ADDED',
  JOURNAL_WRITTEN: 'JOURNAL_WRITTEN',
  POLL_CREATED: 'POLL_CREATED',
  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
};

export interface AwardResult {
  awarded: boolean;
  amount: number;
  /** Vì sao không được thưởng — để client hiển thị hoặc để soát lỗi. */
  skipped?: 'duplicate' | 'daily_cap' | 'no_rule';
  balance: number;
}

/**
 * Ví XP cá nhân.
 *
 * Khác với "XP squad" (`GamesService.getXpProgression`) vốn là số ĐẾM SUY RA
 * theo từng chuyến và tự hồi phục sau khi trừ — ví này là số dư thật, nằm ở
 * `users.xp_balance`, và mọi thay đổi đều có một dòng trong `xp_ledger`.
 */
@Injectable()
export class XpService {
  private readonly logger = new Logger(XpService.name);

  constructor(private prisma: PrismaService) {}

  /** Cấp hiện tại, tính từ XP đã kiếm trong đời (tiêu không làm tụt cấp). */
  static levelOf(xpEarned: number): number {
    return Math.floor(xpEarned / XP_PER_LEVEL) + 1;
  }

  /** 0..100 — phần trăm tiến tới cấp kế tiếp. */
  static levelProgress(xpEarned: number): number {
    return Math.round(((xpEarned % XP_PER_LEVEL) / XP_PER_LEVEL) * 100);
  }

  /** Số XP tương ứng một hoạt động, để client hiện "+40 XP" cho khớp. */
  static amountFor(reason: XpReason): number {
    return EARN_RULES[reason]?.amount ?? 0;
  }

  /**
   * Cộng XP cho một hành động.
   *
   * Chống cộng trùng hai lớp:
   *   1. `unique(userId, reason, refId)` — cùng một thực thể không thưởng lại
   *      dù client gọi lại hay có retry.
   *   2. Trần theo ngày — chặn cày bằng cách tạo–xoá liên tục.
   *
   * Không ném lỗi khi không thưởng được: hành động chính (đăng ảnh, ghi chi)
   * phải thành công kể cả khi đã chạm trần.
   */
  async award(
    userId: string,
    reason: XpReason,
    opts: { refId?: string; tripId?: string; amount?: number } = {},
  ): Promise<AwardResult> {
    const rule = EARN_RULES[reason];
    const amount = opts.amount ?? rule?.amount ?? 0;
    if (!rule || amount <= 0) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { xpBalance: true },
      });
      return {
        awarded: false,
        amount: 0,
        skipped: 'no_rule',
        balance: user?.xpBalance ?? 0,
      };
    }

    // Trần ngày tính theo mốc 00:00 giờ máy chủ.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await this.prisma.xpLedger.count({
      where: {
        userId,
        reason,
        delta: { gt: 0 },
        createdAt: { gte: startOfDay },
      },
    });
    if (todayCount >= rule.dailyCap) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { xpBalance: true },
      });
      return {
        awarded: false,
        amount: 0,
        skipped: 'daily_cap',
        balance: user?.xpBalance ?? 0,
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: userId },
          data: {
            xpBalance: { increment: amount },
            xpEarned: { increment: amount },
          },
          select: { xpBalance: true },
        });
        await tx.xpLedger.create({
          data: {
            userId,
            delta: amount,
            reason,
            refId: opts.refId ?? null,
            tripId: opts.tripId ?? null,
            balanceAfter: user.xpBalance,
          },
        });
        return { awarded: true, amount, balance: user.xpBalance };
      });
    } catch (e) {
      // P2002 = đụng unique(userId, reason, refId) → đã thưởng cho thực thể này
      // rồi. Đây là đường đi bình thường khi có retry, không phải lỗi.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { xpBalance: true },
        });
        return {
          awarded: false,
          amount: 0,
          skipped: 'duplicate',
          balance: user?.xpBalance ?? 0,
        };
      }
      throw e;
    }
  }

  /** Cộng XP theo loại Activity. Trả `null` nếu loại đó không sinh XP. */
  async awardForActivity(
    userId: string,
    type: ActivityType,
    opts: { refId?: string; tripId?: string } = {},
  ): Promise<AwardResult | null> {
    const reason = ACTIVITY_TO_REASON[type];
    if (!reason) return null;
    return this.award(userId, reason, opts);
  }

  /**
   * Trừ XP để mua thứ gì đó.
   *
   * Đọc số dư và trừ trong CÙNG một transaction, và dùng `decrement` kèm điều
   * kiện để hai lần bấm mua đồng thời không tiêu quá số dư.
   */
  async spend(
    userId: string,
    amount: number,
    reason: XpReason,
    refId: string,
  ): Promise<{ balance: number }> {
    if (amount <= 0) {
      throw new BadRequestException('errors.xp.invalidAmount');
    }

    return this.prisma.$transaction(async (tx) => {
      // `updateMany` + điều kiện số dư đủ: nếu hai request cùng chạy thì chỉ một
      // cái khớp điều kiện, cái còn lại trả count = 0 và bị từ chối.
      const updated = await tx.user.updateMany({
        where: { id: userId, xpBalance: { gte: amount } },
        data: { xpBalance: { decrement: amount } },
      });
      if (updated.count === 0) {
        throw new BadRequestException('errors.xp.notEnough');
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { xpBalance: true },
      });
      await tx.xpLedger.create({
        data: {
          userId,
          delta: -amount,
          reason,
          refId,
          balanceAfter: user.xpBalance,
        },
      });
      return { balance: user.xpBalance };
    });
  }

  /** Ví của tôi: số dư, tổng đã kiếm, cấp, và vài giao dịch gần nhất. */
  async getWallet(userId: string) {
    const [user, ledger] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { xpBalance: true, xpEarned: true },
      }),
      this.prisma.xpLedger.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          delta: true,
          reason: true,
          balanceAfter: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      balance: user.xpBalance,
      earned: user.xpEarned,
      level: XpService.levelOf(user.xpEarned),
      levelProgress: XpService.levelProgress(user.xpEarned),
      xpPerLevel: XP_PER_LEVEL,
      // Client dịch `reason` sang tiếng người; BE không trả câu tiếng Việt cứng.
      history: ledger,
    };
  }

  /**
   * Đối chiếu số dư với sổ cái.
   *
   * Số dư và sổ cái luôn được ghi trong cùng transaction nên về lý thuyết không
   * lệch. Hàm này để soát khi nghi ngờ, và là chỗ dựng lại nếu có sự cố.
   */
  async audit(userId: string) {
    const sum = await this.prisma.xpLedger.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { xpBalance: true },
    });
    const fromLedger = sum._sum.delta ?? 0;
    const ok = fromLedger === user.xpBalance;
    if (!ok) {
      this.logger.warn(
        `Số dư XP lệch sổ cái: user=${userId} balance=${user.xpBalance} ledger=${fromLedger}`,
      );
    }
    return { balance: user.xpBalance, fromLedger, ok };
  }
}
