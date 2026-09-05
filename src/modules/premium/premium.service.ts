import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';

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

  constructor(
    private prisma: PrismaService,
    private entitlements: EntitlementService,
  ) {}

  private readonly activePromoCodes: Record<string, PromoDetails> = {
    MATEYCHAT: {
      discount: 0.15,
      description: '15% Off Matey Companion Launch',
    },
    DALATCHILL: { discount: 0.2, description: '20% Off Dalat Adventure Tier' },
    ELITESQUAD: { discount: 0.5, description: '50% Off Half-Price Trial' },
  };

  /// Trạng thái gói hiện tại, đọc từ bảng `Subscription`.
  ///
  /// Trước đây hàm này suy ra premium bằng cách tìm chuỗi
  /// `'ELITE_SQUAD_SUBSCRIPTION'` trong trường `note` của `PaymentTransaction`
  /// — bảng vốn dùng để ghi chuyển tiền giữa các thành viên trong chuyến. Cách
  /// đó có ba lỗ hổng: khớp `contains` trên text tự do nên ghi chú nào chứa
  /// chuỗi đó cũng thành premium; **không kiểm tra hết hạn** nên một lần trả
  /// tiền là premium vĩnh viễn; và không có chỗ ghi gia hạn hay huỷ.
  async getSubscriptions(userId: string) {
    const ent = await this.entitlements.of(userId);

    if (ent.via === 'none') {
      return {
        userId,
        plan: 'FREE',
        status: 'INACTIVE',
        price: 0,
        billingCycle: 'NONE',
        activeUntil: null,
        via: 'none',
        limits: ent.limits,
      };
    }

    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    return {
      userId,
      plan: ent.plan,
      status: 'ACTIVE',
      // Giá theo mặt bằng Việt Nam: mốc tham chiếu của người dùng là YouTube
      // Premium 79.000đ. Mức 99.000đ cũ còn đắt hơn cả nó.
      price: ent.plan === 'SQUAD' ? 99000 : 39000,
      billingCycle: 'MONTHLY',
      activeUntil: ent.activeUntil,
      // Dùng ghế của người khác thì không có gì để tự gia hạn hay huỷ.
      via: ent.via,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      seats: sub?.seats ?? 1,
      limits: ent.limits,
    };
  }

  /// Quyền hiện tại — client dùng để biết cái gì bị khoá và giới hạn bao nhiêu.
  entitlement(userId: string) {
    return this.entitlements.of(userId);
  }

  /// Huỷ gia hạn; vẫn dùng được tới hết kỳ đã trả.
  cancelSubscription(userId: string) {
    return this.entitlements.cancel(userId);
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

  /// Mã đơn hàng cho gói đăng ký.
  ///
  /// Mọi thứ cần để cấp quyền đều nằm trong chính mã đơn:
  /// `tmsub.<userId>.<plan>.<months>`. Cổng thanh toán trả lại nguyên mã này ở
  /// webhook, nên không cần bảng đơn hàng chờ riêng — và cũng không thể bị sửa
  /// giữa đường vì chữ ký của cổng bao trùm mã đơn.
  static buildOrderId(userId: string, plan: 'PLUS' | 'SQUAD', months: number) {
    return `tmsub.${userId}.${plan}.${months}.${Date.now()}`;
  }

  private parseOrderId(orderId: string | undefined) {
    if (!orderId || !orderId.startsWith('tmsub.')) return null;
    const [, userId, plan, months] = orderId.split('.');
    if (!userId || (plan !== 'PLUS' && plan !== 'SQUAD')) return null;
    const m = Number(months);
    if (!Number.isFinite(m) || m < 1 || m > 24) return null;
    return { userId, plan: plan as 'PLUS' | 'SQUAD', months: m };
  }

  /// Webhook Momo.
  ///
  /// **Bản trước đọc `MOMO_SECRET_KEY` ra rồi không dùng đến.** Không kiểm tra
  /// chữ ký nghĩa là bất kỳ ai biết đường dẫn cũng gửi được `resultCode: 0` và
  /// nhận gói miễn phí. Nay chữ ký được kiểm trước, sai thì từ chối thẳng.
  ///
  /// Chuỗi ký theo đúng thứ tự trường mà Momo quy định — sai thứ tự là sai chữ
  /// ký, nên không tự sắp xếp lại được.
  async handleMomoIpn(payload: any) {
    const secretKey = process.env.MOMO_SECRET_KEY;
    if (!secretKey) {
      this.logger.error('Thiếu MOMO_SECRET_KEY — từ chối IPN');
      throw new ServiceUnavailableException('errors.premium.gatewayNotConfigured');
    }

    const raw =
      `accessKey=${process.env.MOMO_ACCESS_KEY ?? ''}` +
      `&amount=${payload.amount ?? ''}` +
      `&extraData=${payload.extraData ?? ''}` +
      `&message=${payload.message ?? ''}` +
      `&orderId=${payload.orderId ?? ''}` +
      `&orderInfo=${payload.orderInfo ?? ''}` +
      `&orderType=${payload.orderType ?? ''}` +
      `&partnerCode=${payload.partnerCode ?? ''}` +
      `&payType=${payload.payType ?? ''}` +
      `&requestId=${payload.requestId ?? ''}` +
      `&responseTime=${payload.responseTime ?? ''}` +
      `&resultCode=${payload.resultCode ?? ''}` +
      `&transId=${payload.transId ?? ''}`;

    const expected = createHmac('sha256', secretKey).update(raw).digest('hex');
    if (!this.safeEqual(expected, String(payload.signature ?? ''))) {
      this.logger.warn(`IPN Momo sai chữ ký: order=${payload.orderId}`);
      throw new BadRequestException('errors.premium.badSignature');
    }

    const ok = payload.resultCode === 0 || payload.resultCode === '0';
    if (ok) {
      await this.fulfill(payload.orderId, 'MOMO', String(payload.transId ?? ''));
    }
    return { resultCode: 0, message: 'IPN processed successfully' };
  }

  /// Webhook ZaloPay.
  ///
  /// Cùng lỗ hổng như Momo: `ZALOPAY_KEY2` được đọc ra nhưng không dùng. ZaloPay
  /// ký bằng HMAC-SHA256 trên **chuỗi `data` nguyên văn** — phải ký trên chuỗi
  /// gốc chứ không phải trên object đã parse, vì parse rồi stringify lại sẽ đổi
  /// thứ tự khoá và ra chữ ký khác.
  async handleZaloPayIpn(payload: any) {
    const key2 = process.env.ZALOPAY_KEY2;
    if (!key2) {
      this.logger.error('Thiếu ZALOPAY_KEY2 — từ chối IPN');
      throw new ServiceUnavailableException('errors.premium.gatewayNotConfigured');
    }

    const dataStr = typeof payload.data === 'string' ? payload.data : '';
    const expected = createHmac('sha256', key2).update(dataStr).digest('hex');
    if (!this.safeEqual(expected, String(payload.mac ?? ''))) {
      this.logger.warn('IPN ZaloPay sai chữ ký');
      // ZaloPay quy ước trả về mã lỗi trong thân phản hồi, không dùng HTTP 4xx.
      return { return_code: -1, return_message: 'mac not equal' };
    }

    let data: any = {};
    try {
      data = JSON.parse(dataStr);
    } catch {
      return { return_code: -1, return_message: 'bad data' };
    }

    // `embed_data` mang mã đơn của mình; `app_trans_id` là mã của ZaloPay.
    let embed: any = {};
    try {
      embed =
        typeof data.embed_data === 'string'
          ? JSON.parse(data.embed_data)
          : (data.embed_data ?? {});
    } catch {
      embed = {};
    }

    await this.fulfill(
      embed.orderId ?? data.app_trans_id,
      'ZALOPAY',
      String(data.zp_trans_id ?? data.app_trans_id ?? ''),
    );
    return { return_code: 1, return_message: 'Success' };
  }

  /// So sánh chữ ký theo thời gian hằng định.
  ///
  /// So bằng `===` để lộ độ dài tiền tố khớp qua thời gian chạy, đủ để dò dần
  /// ra chữ ký đúng.
  private safeEqual(a: string, b: string) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /// Cấp quyền sau khi cổng thanh toán xác nhận trả tiền thành công.
  ///
  /// Đây là mắt xích trước đây **hoàn toàn không tồn tại**: webhook cũ chỉ đổi
  /// `status` của `PaymentTransaction` rồi dừng, nên trả tiền xong người dùng
  /// vẫn không nhận được gì.
  private async fulfill(
    orderId: string | undefined,
    provider: 'MOMO' | 'ZALOPAY',
    externalId: string,
  ) {
    const parsed = this.parseOrderId(orderId);
    if (!parsed) {
      this.logger.warn(`Bỏ qua IPN: mã đơn không hợp lệ "${orderId}"`);
      return;
    }

    // `@@unique([provider, externalId])` ở tầng database chặn cấp trùng khi
    // cổng gọi lại webhook nhiều lần cho cùng một giao dịch.
    const existing = await this.prisma.subscription.findFirst({
      where: { provider, externalId },
    });
    if (existing) {
      this.logger.log(`IPN trùng, bỏ qua: ${provider}/${externalId}`);
      return;
    }

    await this.entitlements.grant({
      userId: parsed.userId,
      plan: parsed.plan,
      months: parsed.months,
      provider,
      externalId,
    });
    this.logger.log(
      `Đã cấp ${parsed.plan} ${parsed.months} tháng cho ${parsed.userId} qua ${provider}`,
    );
  }
}
