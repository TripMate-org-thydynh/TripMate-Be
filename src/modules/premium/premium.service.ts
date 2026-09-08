import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from './entitlement.service';
import { TrialService } from './trial.service';
import { PromoService } from './promo.service';
import { ReferralService } from './referral.service';
import {
  Gateway,
  PaymentGatewayService,
} from './payment-gateway.service';
import {
  BILLING_TERMS,
  MONTHLY_PRICE,
  PLAN_SEATS,
  PaidPlan,
  SELLABLE_MONTHS,
  isPaidPlan,
  priceOf,
} from './pricing';

export interface BillingItem {
  id: string;
  date: string;
  description: string;
  /** Số tiền thực trả, đã trừ giảm giá. */
  amount: number;
  status: string;
  method: string;
  /** Giá niêm yết trước khi giảm. */
  baseAmount: number;
  discount: number;
  promoCode: string | null;
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
    private gateways: PaymentGatewayService,
    private trials: TrialService,
    private promos: PromoService,
    private referrals: ReferralService,
  ) {}

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
        isTrial: false,
        price: 0,
        billingCycle: 'NONE',
        activeUntil: null,
        via: 'none',
        limits: ent.limits,
      };
    }

    // Tìm cả `TRIALING`: lọc mỗi `ACTIVE` thì người đang dùng thử không có
    // dòng nào, và màn cài đặt hiện gói rỗng cho đúng những người đang được
    // mở khoá.
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    return {
      userId,
      plan: ent.plan,
      status: ent.isTrial ? 'TRIALING' : 'ACTIVE',
      // Giá đọc từ bảng giá dùng chung với lúc tạo đơn, không chép lại số.
      price: isPaidPlan(ent.plan) ? MONTHLY_PRICE[ent.plan] : 0,
      billingCycle: 'MONTHLY',
      activeUntil: ent.activeUntil,
      // Dùng ghế của người khác thì không có gì để tự gia hạn hay huỷ.
      via: ent.via,
      isTrial: ent.isTrial,
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
  async cancelSubscription(userId: string) {
    const res = await this.entitlements.cancel(userId);
    if (res) {
      await this.trials.log(userId, 'SUBSCRIPTION_CANCELED', {
        actor: 'user',
        fromStatus: 'ACTIVE',
        toStatus: 'ACTIVE',
        plan: res.plan,
        meta: { cancelAtPeriodEnd: true, until: res.currentPeriodEnd },
      });
    }
    return res;
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
      amount = 99000 * months;
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

  /// Bảng giá công khai — client vẽ màn chọn gói từ đây, không tự chép số.
  ///
  /// `gateways` rỗng nghĩa là chưa cấu hình cổng nào: UI phải nói "chưa mở
  /// bán" thay vì vẽ nút mua rồi để người dùng bấm vào một lỗi.
  plans() {
    return {
      currency: 'VND',
      gateways: this.gateways.availableGateways(),
      plans: (Object.keys(MONTHLY_PRICE) as PaidPlan[]).map((plan) => ({
        plan,
        monthlyPrice: MONTHLY_PRICE[plan],
        seats: PLAN_SEATS[plan],
        terms: BILLING_TERMS.map((t) => ({
          months: t.months,
          discount: t.discount,
          total: priceOf(plan, t.months),
          /// Giá quy về mỗi tháng — con số người dùng thật sự so sánh.
          perMonth: Math.round(priceOf(plan, t.months) / t.months),
        })),
      })),
    };
  }

  /// Tạo đơn mua gói và trả về chỗ để trả tiền.
  ///
  /// Trước đây hàm này (`checkout`) cấp Premium cho bất kỳ ai gọi tới, chỉ dựa
  /// vào một chuỗi `paymentMethod` do client tự khai — không có cổng thanh
  /// toán nào được gọi. Sau đó nó bị khoá cứng lại, nên nhánh ví đứng yên.
  ///
  /// Nay: server tự tính giá, ghi đơn `PENDING`, rồi mới gọi cổng. **Client
  /// không gửi số tiền** — gửi được thì mua gói năm với giá 1.000đ.
  async createOrder(
    userId: string,
    plan: unknown,
    months: unknown,
    provider: unknown,
    promoCode?: string,
  ) {
    if (!isPaidPlan(plan)) {
      throw new BadRequestException({
        code: 'INVALID_PLAN',
        message: 'errors.premium.invalidPlan',
      });
    }
    const m = Number(months ?? 1);
    if (!SELLABLE_MONTHS.includes(m)) {
      throw new BadRequestException({
        code: 'INVALID_TERM',
        message: 'errors.premium.invalidTerm',
        sellable: SELLABLE_MONTHS,
      });
    }
    if (provider !== 'MOMO' && provider !== 'ZALOPAY') {
      throw new BadRequestException({
        code: 'INVALID_PROVIDER',
        message: 'errors.premium.invalidProvider',
      });
    }
    const gateway = provider;
    if (!this.gateways.availableGateways().includes(gateway)) {
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }

    // Dọn các đơn treo cũ trước khi mở đơn mới. Người dùng bấm mua rồi thoát
    // giữa chừng là chuyện thường; để lại thì lịch sử thanh toán đầy đơn
    // `PENDING` không bao giờ kết thúc.
    await this.expireStaleOrders(userId);

    const baseAmount = priceOf(plan, m);

    // Áp mã giảm giá — chỗ mà bản trước bỏ trống.
    //
    // `validatePromoCode` cũ trả về `discount` rồi không ai dùng tới, nên
    // người dùng nhập mã, thấy "giảm 50%", và trả nguyên giá.
    //
    // Mã hỏng thì **để lỗi đi tiếp**, không âm thầm bỏ qua rồi thu đủ tiền:
    // người dùng phải biết mã của mình không dùng được TRƯỚC khi trả tiền.
    let amount = baseAmount;
    let discount = 0;
    let appliedCode: string | null = null;
    if (promoCode) {
      const applied = await this.promos.validate(promoCode, {
        userId,
        plan,
        amount: baseAmount,
      });
      amount = applied.total;
      discount = applied.discount;
      appliedCode = applied.code;
    }

    const orderId = PremiumService.buildOrderId(userId, plan, m);
    const description = `TripMate ${plan} ${m} thang`;

    // Ghi đơn TRƯỚC khi gọi cổng: gọi cổng xong mới ghi thì một lần crash giữa
    // hai bước là người dùng trả tiền cho một đơn không tồn tại, và webhook về
    // sẽ không có gì để đối chiếu.
    await this.prisma.paymentOrder.create({
      data: {
        orderId,
        userId,
        plan,
        months: m,
        amount,
        baseAmount,
        discountAmount: discount,
        promoCode: appliedCode,
        provider: gateway,
      },
    });

    // Cổng thanh toán không nhận giao dịch 0 đồng, nên đơn miễn phí (mã giảm 100%)
    // phải được hoàn tất và cấp quyền ngay tại server mà không gọi qua cổng.
    const isZeroAmount =
      typeof amount === 'number'
        ? amount === 0
        : typeof (amount as any)?.isZero === 'function'
          ? (amount as any).isZero()
          : Number(amount) === 0;

    if (isZeroAmount) {
      await this.prisma.paymentOrder.update({
        where: { orderId },
        data: {
          status: 'SUCCESS',
          paidAt: new Date(),
        },
      });

      await this.entitlements.grant({
        userId,
        plan,
        months: m,
        provider: 'CASH',
        externalId: undefined,
      });

      if (appliedCode && discount > 0) {
        await this.promos.redeem({
          code: appliedCode,
          userId,
          orderId,
          discountApplied: discount,
        });
      }

      await this.trials.markConverted(userId);

      await this.trials.log(userId, 'SUBSCRIPTION_GRANTED', {
        actor: 'system:promo_100',
        toStatus: 'ACTIVE',
        plan,
        meta: { orderId, promoCode: appliedCode, months: m },
      });

      this.logger.log(
        `Đơn miễn phí 0đ (${orderId}) áp mã "${appliedCode}": đã hoàn tất và cấp ${plan} ${m} tháng cho ${userId}`,
      );

      return {
        orderId,
        plan,
        months: m,
        amount,
        baseAmount,
        discount,
        promoCode: appliedCode,
        provider: gateway,
        payUrl: null,
        deeplink: null,
        qrCodeUrl: null,
        paid: true,
      };
    }

    try {
      const created = await this.gateways.create({
        gateway,
        orderId,
        amount,
        description,
        userId,
      });
      return {
        orderId,
        plan,
        months: m,
        amount,
        baseAmount,
        discount,
        promoCode: appliedCode,
        provider: gateway,
        payUrl: created.payUrl,
        deeplink: created.deeplink,
        qrCodeUrl: created.qrCodeUrl,
      };
    } catch (e) {
      // Cổng từ chối thì đơn không bao giờ được trả tiền — đóng lại ngay thay
      // vì để nó nằm `PENDING` chờ hết hạn.
      await this.prisma.paymentOrder.update({
        where: { orderId },
        data: { status: 'FAILED', failureReason: 'GATEWAY_CREATE_FAILED' },
      });
      throw e;
    }
  }

  /// Trạng thái một đơn — client hỏi lại sau khi ví đẩy người dùng về app.
  ///
  /// Cần thiết vì webhook và người dùng quay lại app là hai đường đua nhau:
  /// người dùng thường về trước khi cổng kịp gọi. Không có chỗ hỏi thì màn
  /// "đang xử lý" không bao giờ thoát.
  async getOrder(userId: string, orderId: string) {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId },
    });
    // Không phân biệt "không có" với "của người khác" — nói khác nhau là để lộ
    // đơn nào tồn tại.
    if (!order || order.userId !== userId) {
      throw new BadRequestException({
        code: 'ORDER_NOT_FOUND',
        message: 'errors.premium.orderNotFound',
      });
    }
    return {
      orderId: order.orderId,
      plan: order.plan,
      months: order.months,
      amount: Number(order.amount),
      provider: order.provider,
      status: order.status,
      paidAt: order.paidAt,
      failureReason: order.failureReason,
    };
  }

  /// Đóng các đơn `PENDING` quá hạn.
  ///
  /// 30 phút là quá dư cho một lần mở ví: link thanh toán của cả Momo lẫn
  /// ZaloPay đều hết hiệu lực trước mốc đó.
  private async expireStaleOrders(userId: string) {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    await this.prisma.paymentOrder.updateMany({
      where: { userId, status: 'PENDING', createdAt: { lt: cutoff } },
      data: { status: 'CANCELLED', failureReason: 'EXPIRED' },
    });
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
    // Đọc từ `PaymentOrder`, không phải `PaymentTransaction`.
    //
    // `PaymentTransaction` bắt buộc có `receiverId` là một User vì nó sinh ra
    // để ghi chuyển tiền giữa các thành viên trong chuyến — mua gói thì không
    // có người nhận nào, nên không đơn mua gói nào từng lọt vào đó. Lịch sử
    // thanh toán vì thế luôn rỗng kể cả với người đã trả tiền.
    const rows = await this.prisma.paymentOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const history: BillingItem[] = rows.map((r) => ({
      id: r.orderId,
      date: (r.paidAt ?? r.createdAt).toISOString().slice(0, 10),
      description: `TripMate ${r.plan} · ${r.months} tháng`,
      amount: Number(r.amount),
      status: r.status,
      method: r.provider,
      // Hoá đơn nói rõ đã giảm bao nhiêu và bằng mã nào — không có thì người
      // dùng thấy một con số lạ và không biết vì sao mình trả ít hơn niêm yết.
      baseAmount: Number(r.baseAmount),
      discount: Number(r.discountAmount),
      promoCode: r.promoCode,
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

  /// Nhập mã giới thiệu của bạn bè.
  submitReferral(userId: string, code: string) {
    return this.referrals.submit(userId, code);
  }

  /// Mã giới thiệu của tôi kèm số liệu thật.
  myReferral(userId: string) {
    return this.referrals.myCode(userId);
  }

  /// Tôi đã được ai giới thiệu chưa.
  referralStatus(userId: string) {
    return this.referrals.status(userId);
  }

  /// Kiểm mã giảm giá cho một gói cụ thể.
  ///
  /// Nhận thêm `plan`/`months` để trả về **số tiền được giảm thật**, không chỉ
  /// một tỉ lệ phần trăm trừu tượng — người dùng cần thấy con số cuối cùng
  /// trước khi bấm mua.
  validatePromoCode(
    code: string,
    userId?: string,
    plan?: unknown,
    months?: unknown,
  ) {
    const p = isPaidPlan(plan) ? plan : undefined;
    const m = Number(months ?? 1);
    const amount =
      p && SELLABLE_MONTHS.includes(m) ? priceOf(p, m) : undefined;
    return this.promos.validate(code, { userId, plan: p, amount });
  }

  /// Các mã đang chạy.
  activePromos() {
    return this.promos.listActive();
  }

  /// Chợ nhà sáng tạo.
  ///
  /// **Chợ này chưa tồn tại.** Không có luồng nộp tác phẩm, không có người
  /// sáng tạo, và theme/sticker được mua bằng XP chứ không bằng tiền — danh
  /// mục là một mảng do team soạn trong `store.catalog.ts`. Nên không có
  /// doanh thu nào để chia, và không có khoản chi trả nào đang chờ.
  ///
  /// Bản trước trả về 1.450.000đ doanh thu, 70% chia cho người sáng tạo,
  /// 450.000đ chờ chi trả, kèm ba giao dịch có tên người mua cụ thể — tất cả
  /// đều bịa, và giống nhau ở mọi tài khoản. Một người mở màn này ra sẽ tin
  /// mình đang có tiền chờ rút.
  ///
  /// Nay trả về đúng những gì đo được thật: hoạt động của người này trong cửa
  /// hàng XP đang chạy, kèm cờ nói rõ chợ chưa mở.
  async getCreatorRevenue(userId: string) {
    const [stickers, themes, spent] = await Promise.all([
      this.prisma.userSticker.count({ where: { userId } }),
      this.prisma.userTheme.count({ where: { userId } }),
      this.prisma.xpLedger.aggregate({
        where: {
          userId,
          reason: { in: ['STICKER_PURCHASE', 'THEME_PURCHASE'] },
        },
        _sum: { delta: true },
      }),
    ]);

    return {
      userId,
      /// Chợ nhà sáng tạo đã mở chưa. Client dùng để hiện trạng thái "sắp có"
      /// thay vì vẽ một bảng doanh thu rỗng.
      marketplaceOpen: false,
      /// Cửa hàng hiện tại tiêu XP, không tiêu tiền — nên đơn vị là XP.
      currency: 'XP',
      stickersOwned: stickers,
      themesOwned: themes,
      /// `spend()` ghi số âm vào sổ cái, nên đảo dấu để ra số đã tiêu.
      xpSpent: Math.abs(Number(spent._sum.delta ?? 0)),
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
    return { userId, plan: plan, months: m };
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
      await this.fulfill(
        payload.orderId,
        'MOMO',
        String(payload.transId ?? ''),
        Number(payload.amount),
      );
    } else {
      // Momo báo mã lỗi cụ thể (người dùng huỷ, không đủ số dư, hết hạn...).
      // Giữ lại để màn thanh toán nói được lý do thay vì treo mãi.
      await this.failOrder(
        payload.orderId,
        `MOMO_${payload.resultCode}`,
        String(payload.transId ?? ''),
      );
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

    // ZaloPay chỉ gọi callback khi giao dịch **thành công** — thất bại thì
    // không có callback nào cả, nên đơn hỏng được dọn bằng `expireStaleOrders`
    // chứ không phải ở đây.
    await this.fulfill(
      embed.orderId ?? data.app_trans_id,
      'ZALOPAY',
      String(data.zp_trans_id ?? data.app_trans_id ?? ''),
      Number(data.amount),
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
    paidAmount?: number,
  ) {
    const parsed = this.parseOrderId(orderId);
    if (!parsed) {
      this.logger.warn(`Bỏ qua IPN: mã đơn không hợp lệ "${orderId}"`);
      return;
    }

    // Đơn phải tồn tại. Trước đây không có bảng đơn nào, nên `fulfill` chỉ còn
    // biết tin vào chính mã đơn — mà mã đơn tự mang `plan` và `months`. Ai dựng
    // được một giao dịch 1.000đ mang mã `tmsub.<id>.SQUAD.12` là nhận trọn một
    // năm Squad.
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId: orderId as string },
    });
    if (!order) {
      this.logger.warn(`Bỏ qua IPN: không có đơn "${orderId}"`);
      return;
    }

    // Idempotent ở tầng đơn: cổng gọi lại webhook nhiều lần cho cùng một giao
    // dịch là hành vi bình thường, không phải lỗi.
    if (order.status === 'SUCCESS') {
      this.logger.log(`IPN trùng, đơn đã xử lý: ${orderId}`);
      return;
    }

    // Đơn đã kết thúc ở trạng thái khác PENDING (FAILED, CANCELLED...) thì bỏ qua,
    // không cấp quyền cho đơn đã huỷ hoặc thất bại.
    if (order.status !== 'PENDING') {
      this.logger.warn(
        `Bỏ qua IPN: đơn ${orderId} đang ở trạng thái "${order.status}", không phải PENDING`,
      );
      return;
    }

    // Số tiền phải khớp đơn. Đây là chốt chặn duy nhất giữa "trả 1.000đ" và
    // "nhận gói năm" — mã đơn không tự bảo vệ được điều đó.
    if (paidAmount !== undefined && Number(order.amount) !== paidAmount) {
      this.logger.error(
        `IPN sai số tiền: đơn ${orderId} cần ${order.amount.toString()}, cổng báo ${paidAmount}`,
      );
      await this.prisma.paymentOrder.update({
        where: { orderId: order.orderId },
        data: { status: 'FAILED', failureReason: 'AMOUNT_MISMATCH', externalId },
      });
      return;
    }

    // Đơn còn giữ nguyên `plan`/`months` chốt lúc tạo. Dùng chúng, không dùng
    // giá trị đọc từ mã đơn: mã đơn đi qua tay cổng, còn dòng này thì không.
    if (order.plan === 'FREE') {
      this.logger.error(`Đơn ${orderId} mang gói FREE — bỏ qua`);
      return;
    }

    // `@@unique([provider, externalId])` ở tầng database chặn cấp trùng khi
    // cổng gọi lại webhook bằng một mã đơn khác cho cùng giao dịch.
    const existing = await this.prisma.subscription.findFirst({
      where: { provider, externalId },
    });
    if (existing) {
      // Cùng người dùng: đây là lần gọi lại của chính giao dịch đó, đóng đơn
      // và thôi.
      if (existing.userId === order.userId) {
        this.logger.log(`IPN trùng, bỏ qua: ${provider}/${externalId}`);
        await this.prisma.paymentOrder.update({
          where: { orderId: order.orderId },
          data: { status: 'SUCCESS', externalId, paidAt: new Date() },
        });
        return;
      }
      // Khác người dùng: mã giao dịch của cổng lẽ ra là duy nhất toàn hệ
      // thống, nên trường hợp này là bất thường thật sự — hoặc cổng cấp trùng
      // mã, hoặc có người đang phát lại webhook của giao dịch người khác. Đóng
      // đơn lại và báo động thay vì âm thầm cấp gói.
      this.logger.error(
        `Mã giao dịch ${provider}/${externalId} đã thuộc về người khác — từ chối đơn ${order.orderId}`,
      );
      await this.prisma.paymentOrder.update({
        where: { orderId: order.orderId },
        data: { status: 'FAILED', failureReason: 'EXTERNAL_ID_CONFLICT' },
      });
      return;
    }

    // Giành quyền xử lý bằng atomic update (chuyển PENDING -> SUCCESS trước khi
    // thực hiện side-effects). Vì enum PaymentStatus không có 'PROCESSING', việc
    // cập nhật có điều kiện `where: { status: 'PENDING' }` tận dụng cơ chế khóa
    // hàng (row-level lock) của database để đảm bảo chỉ đúng MỘT tiến trình
    // giành được quyền xử lý, loại bỏ hoàn toàn race condition check-then-act.
    const claimed = await this.prisma.paymentOrder.updateMany({
      where: { orderId: order.orderId, status: 'PENDING' },
      data: { status: 'SUCCESS', externalId, paidAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.log(
        `IPN trùng hoặc đơn đang được xử lý bởi tiến trình khác: ${orderId}`,
      );
      return;
    }

    try {
      await this.entitlements.grant({
        userId: order.userId,
        plan: order.plan,
        months: order.months,
        provider,
        externalId,
      });

      // Ghi lượt dùng mã giảm giá — chỉ ở đây, khi tiền đã thật sự vào.
      //
      // Ghi lúc tạo đơn thì mọi đơn bị bỏ giữa chừng đều đốt một suất, và một
      // người bấm mua rồi thoát vài lần là tự khoá mình khỏi mã.
      if (order.promoCode && Number(order.discountAmount) > 0) {
        await this.promos.redeem({
          code: order.promoCode,
          userId: order.userId,
          orderId: order.orderId,
          discountApplied: Number(order.discountAmount),
        });
      }

      // Mua trong lúc còn dùng thử là tín hiệu quan trọng nhất để biết trial có
      // tác dụng hay không — đóng lần dùng thử lại với kết cục CONVERTED thay vì
      // để nó hết hạn như thể người dùng đã bỏ đi.
      await this.trials.markConverted(order.userId);

      await this.trials.log(order.userId, 'SUBSCRIPTION_GRANTED', {
        actor: `webhook:${provider}`,
        toStatus: 'ACTIVE',
        plan: order.plan,
        meta: { orderId: order.orderId, externalId, months: order.months },
      });

      this.logger.log(
        `Đã cấp ${order.plan} ${order.months} tháng cho ${order.userId} qua ${provider}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      // Nếu cấp quyền hoặc xử lý hậu kỳ thất bại, hoàn trả trạng thái đơn về PENDING
      // để lượt IPN retry tiếp theo từ cổng thanh toán có cơ hội xử lý lại,
      // tránh việc đơn bị chốt 'SUCCESS' oan trong khi người dùng chưa nhận được gói.
      this.logger.error(
        `Lỗi khi cấp quyền cho đơn ${order.orderId}, hoàn lại PENDING để webhook retry: ${message}`,
        stack,
      );
      await this.prisma.paymentOrder.update({
        where: { orderId: order.orderId },
        data: {
          status: 'PENDING',
          paidAt: null,
          failureReason: `GRANT_FAILED: ${message}`,
        },
      });
      throw error;
    }
  }

  /// Ghi nhận một lần trả tiền thất bại từ phía cổng.
  ///
  /// Trước đây webhook chỉ xử lý nhánh thành công rồi im lặng bỏ qua phần còn
  /// lại, nên người dùng huỷ giữa chừng để lại một đơn `PENDING` vĩnh viễn và
  /// màn "đang xử lý" không bao giờ thoát.
  private async failOrder(
    orderId: string | undefined,
    reason: string,
    externalId?: string,
  ) {
    if (!orderId) return;
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId },
    });
    if (!order || order.status !== 'PENDING') return;
    await this.prisma.paymentOrder.update({
      where: { orderId },
      data: { status: 'FAILED', failureReason: reason, externalId },
    });
    this.logger.warn(`Đơn ${orderId} thất bại: ${reason}`);
  }
}
