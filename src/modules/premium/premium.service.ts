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

  /// Endpoint checkout cũ.
  ///
  /// Giữ lại để client cũ không vỡ, nhưng chỉ điểm sang luồng mới — nó vốn
  /// nhận `paymentMethod` do client tự khai và không gọi cổng nào.
  checkout(userId: string, tier: string, paymentMethod: string) {
    this.logger.warn(
      `checkout cũ bị gọi, chuyển hướng sang /premium/orders: user=${userId} tier=${tier} method=${paymentMethod}`,
    );
    throw new BadRequestException({
      code: 'USE_ORDERS_ENDPOINT',
      message: 'errors.premium.checkoutNotAvailable',
    });
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
