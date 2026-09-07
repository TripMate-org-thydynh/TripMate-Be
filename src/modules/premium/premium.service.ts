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
      price: ent.plan === 'SQUAD' ? 10000 : 39000,
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

  /// Thanh toán khởi tạo cho MoMo và ZaloPay.
  async checkout(
    userId: string,
    tierOrDto:
      | string
      | {
          plan?: string;
          tier?: string;
          months?: number;
          paymentMethod?: string;
          redirectUrl?: string;
        },
    paymentMethodArg?: string,
    monthsArg?: number,
  ) {
    let planInput = 'PLUS';
    let monthsInput = 1;
    let methodInput = 'MOMO';
    let redirectUrlInput: string | undefined = undefined;

    if (typeof tierOrDto === 'object' && tierOrDto !== null) {
      planInput = tierOrDto.plan || tierOrDto.tier || 'PLUS';
      monthsInput = tierOrDto.months ?? 1;
      methodInput = tierOrDto.paymentMethod || 'MOMO';
      redirectUrlInput = tierOrDto.redirectUrl;
    } else {
      planInput = tierOrDto || 'PLUS';
      monthsInput = monthsArg ?? 1;
      methodInput = paymentMethodArg || 'MOMO';
    }

    const normMethod = methodInput.trim().toUpperCase();
    let plan: 'PLUS' | 'SQUAD' = 'PLUS';
    let months = monthsInput;
    let amount = 39000;

    const normPlan = planInput.trim().toUpperCase();
    if (normPlan === 'PLUS_YEARLY' || (normPlan === 'PLUS' && months === 12)) {
      plan = 'PLUS';
      months = 12;
      amount = 299000;
    } else if (normPlan === 'SQUAD' || normPlan === 'SQUAD_MONTHLY') {
      plan = 'SQUAD';
      months = months > 0 ? months : 1;
      amount = 10000 * months;
    } else if (normPlan === 'PLUS' || normPlan === 'PLUS_MONTHLY') {
      plan = 'PLUS';
      months = months > 0 ? months : 1;
      amount = months === 12 ? 299000 : 39000 * months;
    } else {
      throw new BadRequestException(
        `Gói ${planInput} không hợp lệ! Vui lòng chọn PLUS hoặc SQUAD.`,
      );
    }

    this.logger.log(
      `Khởi tạo thanh toán: user=${userId}, plan=${plan}, months=${months}, amount=${amount}, method=${normMethod}`,
    );

    if (normMethod === 'MOMO') {
      return this.createMomoPayment(
        userId,
        plan,
        months,
        amount,
        redirectUrlInput,
      );
    } else if (normMethod === 'ZALOPAY') {
      return this.createZaloPayPayment(
        userId,
        plan,
        months,
        amount,
        redirectUrlInput,
      );
    } else if (
      normMethod === 'SEPAY' ||
      normMethod === 'VIETQR' ||
      normMethod === 'BANK_TRANSFER'
    ) {
      return this.createSepayPayment(userId, plan, months, amount);
    } else {
      throw new BadRequestException(
        `Phương thức thanh toán ${normMethod} không được hỗ trợ. Chỉ hỗ trợ MOMO, ZALOPAY, hoặc SEPAY.`,
      );
    }
  }

  private async createSepayPayment(
    userId: string,
    plan: 'PLUS' | 'SQUAD',
    months: number,
    amount: number,
  ) {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let randomPart = '';
    for (let i = 0; i < 6; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const orderCode = `TM${randomPart}`;

    await this.prisma.paymentTransaction.create({
      data: {
        senderId: userId,
        receiverId: userId,
        amount,
        provider: 'BANK_TRANSFER',
        status: 'PENDING',
        transactionId: orderCode,
        note: JSON.stringify({ plan, months, userId, createdAt: Date.now() }),
      },
    });

    const accountNumber = process.env.SEPAY_ACCOUNT_NUMBER || '0949064234';
    const bankCode = process.env.SEPAY_BANK_CODE || 'MBBank';
    const accountName = process.env.SEPAY_ACCOUNT_NAME || 'CHAU THANH TRUNG';

    const qrUrl = `https://qr.sepay.vn/img?acc=${encodeURIComponent(accountNumber)}&bank=${encodeURIComponent(bankCode)}&amount=${amount}&des=${encodeURIComponent(orderCode)}&template=compact`;
    const vietqrUrl = `https://vietqr.app/img?bank=${encodeURIComponent(bankCode)}&acc=${encodeURIComponent(accountNumber)}&amount=${amount}&des=${encodeURIComponent(orderCode)}&template=compact&showinfo=true&holder=${encodeURIComponent(accountName)}`;
    const payUrl = `https://qr.sepay.vn/gateway?acc=${encodeURIComponent(accountNumber)}&bank=${encodeURIComponent(bankCode)}&amount=${amount}&des=${encodeURIComponent(orderCode)}`;

    return {
      provider: 'SEPAY',
      orderId: orderCode,
      orderCode,
      amount,
      payUrl,
      qrUrl,
      vietqrUrl,
      bankInfo: {
        bankCode,
        accountNumber,
        accountName,
        amount,
        transferContent: orderCode,
      },
    };
  }

  private async createMomoPayment(
    userId: string,
    plan: 'PLUS' | 'SQUAD',
    months: number,
    amount: number,
    customRedirectUrl?: string,
  ) {
    const partnerCode = process.env.MOMO_PARTNER_CODE || 'MOMO';
    const accessKey = process.env.MOMO_ACCESS_KEY || 'F8BBA842ECF85';
    const secretKey = process.env.MOMO_SECRET_KEY;
    if (!secretKey) {
      this.logger.error('Thiếu MOMO_SECRET_KEY trong môi trường.');
      throw new ServiceUnavailableException(
        'errors.premium.gatewayNotConfigured',
      );
    }
    const endpoint =
      process.env.MOMO_ENDPOINT ||
      'https://test-payment.momo.vn/v2/gateway/api/create';
    const redirectUrl =
      customRedirectUrl ||
      process.env.MOMO_REDIRECT_URL ||
      'tripmate://payment/momo/callback';
    const ipnUrl =
      process.env.MOMO_IPN_URL ||
      'https://api.tripmate.vn/api/v1/payment/momo/ipn';

    const orderId = PremiumService.buildOrderId(userId, plan, months);
    const requestId = `req_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const planName = plan === 'SQUAD' ? 'Squad Pass' : 'TripMate+';
    const orderInfo = `Thanh toán ${planName} (${months} tháng)`;
    const extraData = '';
    const requestType = 'captureWallet';

    const rawSignature = `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${ipnUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=${requestType}`;
    const signature = createHmac('sha256', secretKey)
      .update(rawSignature)
      .digest('hex');

    const payload = {
      partnerCode,
      partnerName: 'TripMate',
      storeId: 'TripMateStore',
      requestId,
      amount,
      orderId,
      orderInfo,
      redirectUrl,
      ipnUrl,
      lang: 'vi',
      extraData,
      requestType,
      signature,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as any;
      if (data.resultCode !== 0) {
        this.logger.error(
          `MoMo create payment failed: code=${data.resultCode}, msg=${data.message}`,
        );
        throw new BadRequestException(
          data.message || 'errors.premium.checkoutFailed',
        );
      }
      return {
        provider: 'MOMO',
        orderId,
        amount,
        payUrl: data.payUrl,
        deeplink: data.deeplink,
        qrCodeUrl: data.qrCodeUrl,
        deeplinkMiniApp: data.deeplinkMiniApp,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`MoMo API error: ${err.message}`, err.stack);
      throw new ServiceUnavailableException('errors.premium.gatewayUnavailable');
    }
  }

  private async createZaloPayPayment(
    userId: string,
    plan: 'PLUS' | 'SQUAD',
    months: number,
    amount: number,
    customRedirectUrl?: string,
  ) {
    const appId = Number(process.env.ZALOPAY_APP_ID || 2553);
    const key1 = process.env.ZALOPAY_KEY1;
    if (!key1) {
      this.logger.error('Thiếu ZALOPAY_KEY1 trong môi trường.');
      throw new ServiceUnavailableException(
        'errors.premium.gatewayNotConfigured',
      );
    }
    const endpoint =
      process.env.ZALOPAY_ENDPOINT ||
      'https://sb-openapi.zalopay.vn/v2/create';
    const redirectUrl =
      customRedirectUrl ||
      process.env.ZALOPAY_REDIRECT_URL ||
      'tripmate://payment/zalopay/callback';
    const callbackUrl =
      process.env.ZALOPAY_CALLBACK_URL ||
      'https://api.tripmate.vn/api/v1/payment/zalopay/ipn';

    const orderId = PremiumService.buildOrderId(userId, plan, months);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const transDate = `${String(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const appTransId = `${transDate}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const appTime = Date.now();
    const planName = plan === 'SQUAD' ? 'Squad Pass' : 'TripMate+';
    const description = `Thanh toán ${planName} (${months} tháng)`;
    const embedData = JSON.stringify({ orderId, redirecturl: redirectUrl });
    const items = JSON.stringify([
      { id: plan, name: description, price: amount, quantity: 1 },
    ]);

    const rawMac = `${appId}|${appTransId}|${userId}|${amount}|${appTime}|${embedData}|${items}`;
    const mac = createHmac('sha256', key1).update(rawMac).digest('hex');

    const zaloBody = {
      app_id: appId,
      app_user: userId,
      app_time: appTime,
      amount,
      app_trans_id: appTransId,
      embed_data: embedData,
      item: items,
      description,
      bank_code: '',
      callback_url: callbackUrl,
      mac,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(
          Object.entries(zaloBody).map(([k, v]) => [k, String(v)]),
        ),
      });
      const data = (await res.json()) as any;
      if (data.return_code !== 1) {
        this.logger.error(
          `ZaloPay create payment failed: code=${data.return_code}, msg=${data.return_message}`,
        );
        throw new BadRequestException(
          data.return_message || 'errors.premium.checkoutFailed',
        );
      }
      return {
        provider: 'ZALOPAY',
        orderId,
        amount,
        payUrl: data.order_url,
        deeplink: data.order_url,
        cashierOrderUrl: data.cashier_order_url,
        qrCodeUrl: data.qr_code,
        zpTransToken: data.zp_trans_token,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`ZaloPay API error: ${err.message}`, err.stack);
      throw new ServiceUnavailableException('errors.premium.gatewayUnavailable');
    }
  }

  /// Xác thực biên lai Google Play.
  async verifyGooglePlayPurchase(
    userId: string,
    token: string,
    productId: string,
  ) {
    if (!token || !productId) {
      throw new BadRequestException('Mã token và productId là bắt buộc! 🤪');
    }

    let plan: 'PLUS' | 'SQUAD' = 'PLUS';
    let months = 1;
    const prod = productId.toLowerCase();
    if (prod.includes('squad')) {
      plan = 'SQUAD';
      months = 1;
    } else if (prod.includes('yearly') || prod.includes('annual')) {
      plan = 'PLUS';
      months = 12;
    } else {
      plan = 'PLUS';
      months = 1;
    }

    const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      if (
        process.env.NODE_ENV !== 'production' &&
        process.env.MOCK_GOOGLE_PLAY === 'true'
      ) {
        this.logger.warn(
          `MOCK_GOOGLE_PLAY=true: cấp quyền giả lập cho user=${userId} prod=${productId}`,
        );
        await this.entitlements.grant({
          userId,
          plan,
          months,
          provider: 'GOOGLE_PLAY',
          externalId: token,
        });
        return { success: true, plan, months, via: 'own' };
      }
      this.logger.warn(
        `Chưa cấu hình xác thực Google Play — từ chối: user=${userId} product=${productId}`,
      );
      throw new ServiceUnavailableException(
        'errors.premium.verifyNotConfigured',
      );
    }

    try {
      const { GoogleAuth } = await import('google-auth-library');
      const credentials = JSON.parse(serviceAccountJson);
      const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      const client = await auth.getClient();
      const tokenRes = await client.getAccessToken();
      const accessToken = tokenRes.token;

      const packageName =
        process.env.ANDROID_PACKAGE_NAME || 'com.tripmate.app';
      const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/${productId}/tokens/${token}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = (await res.json()) as any;

      if (data.paymentState === 1 || data.paymentState === 2) {
        await this.entitlements.grant({
          userId,
          plan,
          months,
          provider: 'GOOGLE_PLAY',
          externalId: token,
        });
        return { success: true, plan, months, via: 'own' };
      } else {
        throw new BadRequestException(
          'Biên lai Google Play không hợp lệ hoặc chưa thanh toán.',
        );
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Google Play verify error: ${err.message}`);
      throw new BadRequestException('errors.premium.verifyFailed');
    }
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

  async getOrderStatus(userId: string, orderCode: string) {
    return this.getPublicOrderStatus(orderCode);
  }

  async getPublicOrderStatus(orderCode: string) {
    const tx = await this.prisma.paymentTransaction.findFirst({
      where: {
        transactionId: orderCode,
      },
    });
    if (!tx) {
      return { status: 'NOT_FOUND', isPaid: false };
    }
    return {
      orderCode,
      status: tx.status,
      isPaid: tx.status === 'SUCCESS',
      amount: Number(tx.amount),
    };
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

  /// Webhook SePay (Chuyển khoản VietQR tự động).
  ///
  /// SePay gửi thông báo biến động số dư tài khoản ngân hàng tức thì.
  /// Hệ thống trích xuất mã đơn TM... từ nội dung chuyển khoản, kiểm tra số tiền
  /// và kích hoạt gói cước ngay lập tức.
  async handleSepayWebhook(payload: any, authHeader?: string) {
    const expectedToken = process.env.SEPAY_WEBHOOK_TOKEN || 'MY_SEPAY_SECRET_0406';
    if (expectedToken) {
      let providedToken = '';
      if (authHeader) {
        const parts = authHeader.trim().split(' ');
        providedToken =
          parts.length > 1 ? parts.slice(1).join(' ').trim() : parts[0].trim();
      }
      if (!providedToken || !this.safeEqual(expectedToken, providedToken)) {
        this.logger.warn(`SePay IPN sai token xác thực`);
        throw new BadRequestException('errors.premium.badSignature');
      }
    }

    if (payload?.transferType === 'out') {
      return { success: true, message: 'Ignored outbound transaction' };
    }

    let orderCode = String(payload?.code || '').trim().toUpperCase();
    if (!orderCode || !orderCode.startsWith('TM')) {
      const content = String(payload?.content || '');
      const match =
        content.match(/TM[2-9A-HJ-NP-Z0-9]{4,10}/i) ||
        content.match(/TM[A-Z0-9]{4,10}/i);
      if (match) {
        orderCode = match[0].toUpperCase();
      }
    }

    if (!orderCode) {
      this.logger.log(
        `SePay transaction ${payload?.id} ignored: no orderCode in content "${payload?.content}"`,
      );
      return { success: true, message: 'No TripMate order code found' };
    }

    const tx = await this.prisma.paymentTransaction.findFirst({
      where: {
        transactionId: orderCode,
        provider: 'BANK_TRANSFER',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!tx) {
      this.logger.warn(`SePay order ${orderCode} not found`);
      return { success: false, message: `Order ${orderCode} not found` };
    }

    if (tx.status === 'SUCCESS') {
      this.logger.log(`SePay order ${orderCode} already fulfilled`);
      return { success: true, message: 'Order already fulfilled' };
    }

    const transferAmount = Number(
      payload?.transferAmount ?? payload?.amount ?? 0,
    );
    const expectedAmount = Number(tx.amount);
    if (transferAmount < expectedAmount) {
      this.logger.warn(
        `SePay underpayment for ${orderCode}: got ${transferAmount}, expected ${expectedAmount}`,
      );
      await this.prisma.paymentTransaction.update({
        where: { id: tx.id },
        data: {
          status: 'FAILED',
          note: `${tx.note ?? ''} [UNDERPAID: got ${transferAmount}, expected ${expectedAmount}]`,
        },
      });
      return { success: false, message: 'Underpaid amount' };
    }

    let plan: 'PLUS' | 'SQUAD' = 'PLUS';
    let months = 1;
    try {
      const meta = JSON.parse(tx.note || '{}');
      if (meta.plan === 'SQUAD' || meta.plan === 'PLUS') plan = meta.plan;
      if (meta.months && meta.months > 0) months = meta.months;
    } catch {
      // fallback
    }

    const externalId = String(payload?.id ?? payload?.referenceCode ?? orderCode);

    await this.prisma.paymentTransaction.update({
      where: { id: tx.id },
      data: {
        status: 'SUCCESS',
        note: `${tx.note ?? ''} [SEPAY_ID:${externalId}]`,
      },
    });

    await this.entitlements.grant({
      userId: tx.senderId,
      plan,
      months,
      provider: 'BANK_TRANSFER',
      externalId,
    });

    this.logger.log(
      `SePay: Cấp ${plan} ${months} tháng cho user=${tx.senderId} (order=${orderCode}, sepayId=${externalId})`,
    );
    return { success: true, message: 'Subscription granted successfully' };
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
