import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface BillingItem {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: string;
  method: string;
}

export interface PromoDetails {
  discount: number;
  description: string;
}

@Injectable()
export class PremiumService {
  private readonly logger = new Logger(PremiumService.name);

  constructor(private prisma: PrismaService) {}


  private readonly activePromoCodes: Record<string, PromoDetails> = {
    MATEYCHAT: {
      discount: 0.15,
      description: '15% Off Matey Companion Launch',
    },
    DALATCHILL: { discount: 0.2, description: '20% Off Dalat Adventure Tier' },
    ELITESQUAD: { discount: 0.5, description: '50% Off Half-Price Trial' },
  };

  async getSubscriptions(userId: string) {
    // Dynamic query from database transactions to check active premium
    const subscriptionTx = await this.prisma.paymentTransaction.findFirst({
      where: {
        senderId: userId,
        status: 'SUCCESS',
        note: {
          contains: 'ELITE_SQUAD_SUBSCRIPTION',
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (subscriptionTx) {
      const startDate = subscriptionTx.createdAt.toISOString();
      const nextBillingDate = new Date(subscriptionTx.createdAt);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

      return {
        userId,
        tier: 'ELITE_SQUAD',
        status: 'ACTIVE',
        price: 99000,
        billingCycle: 'MONTHLY',
        startDate,
        nextBillingDate: nextBillingDate.toISOString(),
        benefits: [
          'Không giới hạn AI Recap Exports 🎬',
          'Bộ nhãn dán Social Chaos độc quyền 🕹️',
          'Tải lên file phương tiện độ phân giải gốc 📂',
          'Quyền truy cập sớm các mini-game nâng cao 🎭',
        ],
      };
    }

    // Default to free tier
    return {
      userId,
      tier: 'FREE',
      status: 'INACTIVE',
      price: 0,
      billingCycle: 'NONE',
      startDate: null,
      nextBillingDate: null,
      benefits: ['Giới hạn AI Recap Exports 🎬', 'Bộ nhãn dán cơ bản 🕹️'],
    };
  }

  /// Thanh toán ngoài Google Play.
  ///
  /// Trước đây hàm này cấp Premium cho bất kỳ ai gọi tới, chỉ dựa vào một
  /// chuỗi `paymentMethod` do client tự khai — không có cổng thanh toán nào
  /// được gọi. Đó vừa là lỗ hổng doanh thu, vừa vi phạm chính sách Google
  /// Play (hàng hoá số trong app Android bắt buộc dùng Play Billing).
  ///
  /// Giữ lại endpoint để không phá client cũ, nhưng từ chối thẳng cho tới khi
  /// có tích hợp cổng thanh toán thật.
  checkout(userId: string, tier: string, paymentMethod: string) {
    this.logger.warn(
      `Từ chối checkout ngoài Play: user=${userId} tier=${tier} method=${paymentMethod}`,
    );
    throw new BadRequestException('errors.premium.checkoutNotAvailable');
  }

  /// Xác thực biên lai Google Play.
  ///
  /// CHƯA được kích hoạt: cần Service Account của Google Play Developer API
  /// (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) để gọi
  /// `purchases.subscriptions.get` và kiểm tra biên lai với Google. Nếu không
  /// verify, bất kỳ client nào cũng có thể gửi token bịa và nhận Premium.
  ///
  /// Xem EXTERNAL_SETUP.md mục 8 (In-app purchase).
  verifyGooglePlayPurchase(userId: string, token: string, productId: string) {
    if (!token || !productId) {
      throw new BadRequestException('Mã token và productId là bắt buộc! 🤪');
    }

    this.logger.warn(
      `Chưa cấu hình xác thực Google Play — từ chối: user=${userId} product=${productId}`,
    );
    throw new ServiceUnavailableException('errors.premium.verifyNotConfigured');
  }

  /// Lịch sử thanh toán của chính người dùng.
  ///
  /// Trước đây trả về một mảng hoá đơn cứng ('Visa **** 4242', 99.000đ...) —
  /// mọi tài khoản, kể cả vừa đăng ký, đều thấy 3 hoá đơn đã thanh toán không
  /// hề tồn tại. Nay đọc từ bảng giao dịch thật; chưa mua gì thì rỗng.
  async getBillingHistory(userId: string) {
    const rows = await this.prisma.paymentTransaction.findMany({
      where: { senderId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const history: BillingItem[] = rows.map((r) => ({
      id: r.id,
      date: r.createdAt.toISOString().slice(0, 10),
      description: r.note ?? 'Giao dịch TripMate',
      amount: Number(r.amount),
      status: r.status,
      method: r.provider,
    }));

    return { userId, history };
  }

  submitReferral(userId: string, code: string) {
    if (code.trim().toUpperCase() === 'SELF') {
      throw new BadRequestException(
        'Không thể tự nhập mã giới thiệu của mình nha cưng! 🤪',
      );
    }
    return {
      success: true,
      userId,
      referredCode: code.toUpperCase(),
      rewardXp: 500,
      message:
        'Mã giới thiệu hợp lệ! Matey tặng cưng 500 XP bứt tốc level nhé! ⚡🏆',
    };
  }

  validatePromoCode(code: string) {
    const uppercaseCode = code.trim().toUpperCase();
    const promo = this.activePromoCodes[uppercaseCode];
    if (!promo) {
      throw new BadRequestException(
        'Mã giảm giá đã hết hạn hoặc không tồn tại! 😢',
      );
    }
    return {
      valid: true,
      code: uppercaseCode,
      discount: promo.discount,
      description: promo.description,
    };
  }

  getCreatorRevenue(userId: string) {
    return {
      userId,
      themesSoldCount: 42,
      stickersSoldCount: 128,
      totalSalesRevenue: 1450000, // VND
      creatorShare: 1015000, // 70% share
      payoutPending: 450000,
      recentSales: [
        {
          item: 'Chủ đề Kyoto Retro 🎋',
          buyer: 'Hoàng Yến',
          price: 49000,
          date: '2026-05-25',
        },
        {
          item: 'Nhãn dán Phú Quốc Shark 🦈',
          buyer: 'Phú Khang',
          price: 15000,
          date: '2026-05-24',
        },
        {
          item: 'Chủ đề Dalat Vintage 🌲',
          buyer: 'Minh Nhật',
          price: 49000,
        },
      ],
    };
  }

  async handleMomoIpn(payload: any) {
    const secretKey = process.env.MOMO_SECRET_KEY || 'momo-secret-key';
    const { orderId, amount, resultCode } = payload;

    const isSuccess = resultCode === 0 || resultCode === '0';
    if (isSuccess && orderId) {
      await this.prisma.paymentTransaction.updateMany({
        where: { transactionId: orderId },
        data: { status: 'SUCCESS' },
      });
    }

    return { resultCode: 0, message: 'IPN processed successfully' };
  }

  async handleZaloPayIpn(payload: any) {
    const key2 = process.env.ZALOPAY_KEY2 || 'zalopay-key2';
    const { data: dataStr, mac } = payload;

    let dataJson: any = {};
    try {
      dataJson = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
    } catch {
      dataJson = {};
    }

    const appTransId = dataJson.app_trans_id;
    if (appTransId) {
      await this.prisma.paymentTransaction.updateMany({
        where: { transactionId: appTransId },
        data: { status: 'SUCCESS' },
      });
    }

    return { return_code: 1, return_message: 'Success' };
  }
}
