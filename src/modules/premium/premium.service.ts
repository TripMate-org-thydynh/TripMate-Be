import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class PremiumService {
  private readonly billingHistory = [
    {
      id: 'inv-001',
      date: '2026-05-20',
      description: 'Elite Squad Subscription (1 Tháng)',
      amount: 99000,
      status: 'PAID',
      method: 'Visa **** 4242',
    },
    {
      id: 'inv-002',
      date: '2026-04-20',
      description: 'Xuất Video Recap Kyoto 4K 🎞️',
      amount: 25000,
      status: 'PAID',
      method: 'MOMO Wallet',
    },
    {
      id: 'inv-003',
      date: '2026-03-15',
      description: 'Chủ Đề Dalat Vintage Premium 🌲',
      amount: 49000,
      status: 'PAID',
      method: 'Techcombank *8899',
    },
  ];

  private readonly activePromoCodes: Record<string, { discount: number; description: string }> = {
    'MATEYCHAT': { discount: 0.15, description: '15% Off Matey Companion Launch' },
    'DALATCHILL': { discount: 0.20, description: '20% Off Dalat Adventure Tier' },
    'ELITESQUAD': { discount: 0.50, description: '50% Off Half-Price Trial' },
  };

  async getSubscriptions(userId: string) {
    return {
      userId,
      tier: 'ELITE_SQUAD',
      status: 'ACTIVE',
      price: 99000,
      billingCycle: 'MONTHLY',
      startDate: '2026-05-20T10:00:00Z',
      nextBillingDate: '2026-06-20T10:00:00Z',
      benefits: [
        'Không giới hạn AI Recap Exports 🎬',
        'Bộ nhãn dán Social Chaos độc quyền 🕹️',
        'Tải lên file phương tiện độ phân giải gốc 📂',
        'Quyền truy cập sớm các mini-game nâng cao 🎭',
      ],
    };
  }

  async checkout(userId: string, tier: string, paymentMethod: string) {
    return {
      success: true,
      transactionId: `txn-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
      userId,
      tier,
      amount: tier === 'ELITE_SQUAD' ? 99000 : 0,
      paymentMethod,
      timestamp: new Date().toISOString(),
      message: 'Kích hoạt Premium thành công! Chúc cưng chuyến đi ngập tràn vibe luxury! 💸✨',
    };
  }

  async getBillingHistory(userId: string) {
    return {
      userId,
      history: this.billingHistory,
    };
  }

  async submitReferral(userId: string, code: string) {
    if (code.trim().toUpperCase() === 'SELF') {
      throw new BadRequestException('Không thể tự nhập mã giới thiệu của mình nha cưng! 🤪');
    }
    return {
      success: true,
      userId,
      referredCode: code.toUpperCase(),
      rewardXp: 500,
      message: 'Mã giới thiệu hợp lệ! Matey tặng cưng 500 XP bứt tốc level nhé! ⚡🏆',
    };
  }

  async validatePromoCode(code: string) {
    const uppercaseCode = code.trim().toUpperCase();
    const promo = this.activePromoCodes[uppercaseCode];
    if (!promo) {
      throw new BadRequestException('Mã giảm giá đã hết hạn hoặc không tồn tại! 😢');
    }
    return {
      valid: true,
      code: uppercaseCode,
      discount: promo.discount,
      description: promo.description,
    };
  }

  async getCreatorRevenue(userId: string) {
    return {
      userId,
      themesSoldCount: 42,
      stickersSoldCount: 128,
      totalSalesRevenue: 1450000, // VND
      creatorShare: 1015000, // 70% share
      payoutPending: 450000,
      recentSales: [
        { item: 'Chủ đề Kyoto Retro 🎋', buyer: 'Hoàng Yến', price: 49000, date: '2026-05-25' },
        { item: 'Nhãn dán Phú Quốc Shark 🦈', buyer: 'Phú Khang', price: 15000, date: '2026-05-24' },
        { item: 'Chủ đề Dalat Vintage 🌲', buyer: 'Minh Nhật', price: 49000, date: '2026-05-23' },
      ],
    };
  }
}
