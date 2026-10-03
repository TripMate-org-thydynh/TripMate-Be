import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
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
import { playProductOf, playProductIdFor } from './google-play';
import {
  GooglePlayBillingService,
  PlayReceiptRejected,
  PlaySubscriptionV2,
} from './google-play-billing.service';

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
    private play: GooglePlayBillingService,
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

    // Gói Play tự gia hạn và chỉ huỷ được trên Google Play — app phải nói
    // đúng điều đó và chỉ đường sang. Kỳ hạn lấy từ hoá đơn Play gần nhất.
    const play =
      sub?.provider === 'GOOGLE_PLAY' && ent.via === 'own'
        ? await this.playManageInfo(userId, sub.plan)
        : null;

    return {
      userId,
      plan: ent.plan,
      status: ent.isTrial ? 'TRIALING' : 'ACTIVE',
      // Giá đọc từ bảng giá dùng chung với lúc tạo đơn, không chép lại số.
      price: play
        ? play.price
        : isPaidPlan(ent.plan)
          ? MONTHLY_PRICE[ent.plan]
          : 0,
      billingCycle: play?.months === 12 ? 'YEARLY' : 'MONTHLY',
      provider: ent.via === 'own' ? (sub?.provider ?? null) : null,
      autoRenew: !!play && !(sub?.cancelAtPeriodEnd ?? false),
      manageUrl: play?.manageUrl ?? null,
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

  /// Kỳ hạn, giá và link "Quản lý gói" trên Google Play cho gói Play.
  private async playManageInfo(userId: string, plan: string) {
    const order = await this.prisma.paymentOrder.findFirst({
      where: { userId, provider: 'GOOGLE_PLAY', status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      select: { months: true },
    });
    const months = order?.months ?? 1;
    const productId = isPaidPlan(plan)
      ? playProductIdFor(plan, months)
      : null;
    const pkg = process.env.ANDROID_PACKAGE_NAME || 'com.tripmate.app';
    return {
      months,
      price: isPaidPlan(plan) ? priceOf(plan, months) : 0,
      // Link chính thức của Google: mở thẳng trang gói này trong Play Store.
      manageUrl: productId
        ? `https://play.google.com/store/account/subscriptions?sku=${productId}&package=${pkg}`
        : `https://play.google.com/store/account/subscriptions?package=${pkg}`,
    };
  }

  /// Huỷ gia hạn; vẫn dùng được tới hết kỳ đã trả.
  async cancelSubscription(userId: string) {
    // Gói Play do Google trừ tiền. Đánh dấu huỷ ở phía mình thì Google VẪN
    // trừ kỳ sau — người dùng tưởng đã huỷ mà vẫn mất tiền. Chỉ đường sang
    // Google Play; trạng thái huỷ sẽ về qua RTDN.
    const latest = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { currentPeriodEnd: 'desc' },
      select: { provider: true, plan: true },
    });
    if (latest?.provider === 'GOOGLE_PLAY') {
      throw new BadRequestException({
        code: 'MANAGED_BY_PLAY',
        message: 'errors.premium.managedByPlay',
        manageUrl: (await this.playManageInfo(userId, latest.plan)).manageUrl,
      });
    }
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

  /// Đường vào cũ của app (`POST /premium/checkout`).
  ///
  /// Giữ lại vì các bản app đã phát hành vẫn gọi nó, nhưng **không còn logic
  /// riêng**: nó chuẩn hoá tham số rồi giao hết cho `createOrder`.
  ///
  /// Trước đây hàm này mang **một bảng giá thứ hai** tự viết trong thân hàm —
  /// PLUS 12 tháng tính 299.000đ trong khi bảng giá thật (`PLAN_PRICE`) là
  /// 374.000đ, còn SQUAD 12 tháng tính `99.000 × 12 = 1.188.000đ` thay vì
  /// 950.000đ. App lấy giá từ `/premium/plans` để hiển thị, rồi thanh toán qua
  /// đường này, nên **số tiền trên mã QR không khớp số tiền người dùng vừa
  /// nhìn thấy**. Nó cũng nhận mọi số tháng (3 tháng, 7 tháng...) là những kỳ
  /// hạn không hề được bán, và bỏ qua sạch mã giảm giá.
  ///
  /// Một bảng giá thì không thể lệch với chính nó. Đó là toàn bộ lý do hàm này
  /// bây giờ chỉ còn là lớp chuyển tiếp.
  async checkout(
    userId: string,
    tierOrDto:
      | string
      | {
          plan?: string;
          tier?: string;
          months?: number;
          paymentMethod?: string;
          provider?: string;
          promoCode?: string;
          redirectUrl?: string;
        },
    paymentMethodArg?: string,
    monthsArg?: number,
  ) {
    let planInput = 'PLUS';
    let monthsInput = 1;
    let methodInput = 'SEPAY';
    let promoCode: string | undefined;

    if (typeof tierOrDto === 'object' && tierOrDto !== null) {
      planInput = tierOrDto.plan || tierOrDto.tier || 'PLUS';
      monthsInput = tierOrDto.months ?? 1;
      methodInput =
        tierOrDto.paymentMethod || tierOrDto.provider || 'SEPAY';
      promoCode = tierOrDto.promoCode;
    } else {
      planInput = tierOrDto || 'PLUS';
      monthsInput = monthsArg ?? 1;
      methodInput = paymentMethodArg || 'SEPAY';
    }

    // App cũ gửi gói và kỳ hạn dính làm một (`PLUS_YEARLY`). Tách ra ở đây,
    // đúng một chỗ, thay vì để mỗi nhánh thanh toán tự đoán lại.
    const normPlan = planInput.trim().toUpperCase();
    let plan = normPlan;
    let months = monthsInput;
    if (normPlan.endsWith('_YEARLY') || normPlan.endsWith('_ANNUAL')) {
      plan = normPlan.replace(/_(YEARLY|ANNUAL)$/, '');
      months = 12;
    } else if (normPlan.endsWith('_MONTHLY')) {
      plan = normPlan.replace(/_MONTHLY$/, '');
      months = 1;
    }

    // `VIETQR` và `BANK_TRANSFER` là tên cũ của cùng một thứ.
    const method = methodInput.trim().toUpperCase();
    const provider =
      method === 'VIETQR' || method === 'BANK_TRANSFER' ? 'SEPAY' : method;

    return this.createOrder(userId, plan, months, provider, promoCode);
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
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json());
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
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(
          Object.entries(zaloBody).map(([k, v]) => [k, String(v)]),
        ),
      });
      const data = (await res.json());
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

  /// Kênh phân phối của bản app đang gọi.
  ///
  /// `play`  — bản tải từ CH Play. Chính sách Payments của Google bắt buộc mọi
  ///           hàng hoá số tiêu thụ trong app phải qua Play Billing.
  /// `direct`— APK tải thẳng từ web TripMate, không qua CH Play.
  /// `web`   — dùng trên trình duyệt.
  ///
  /// Bản `play` **không** được bày SePay cạnh Play Billing: chương trình "User
  /// Choice Billing" của Google chưa mở cho Việt Nam, nên bày song song là
  /// đường ngắn nhất tới việc bị gỡ app. Khi nào VN được mở, bật
  /// `USER_CHOICE_BILLING=true` là hiện cả hai — không phải sửa dòng code nào.
  private clientChannel(raw?: string): 'play' | 'direct' | 'web' {
    const v = (raw ?? '').trim().toLowerCase();
    if (v === 'play' || v === 'direct' || v === 'web') return v;
    // Không khai thì coi như `play` — chọn phía an toàn về chính sách. Đoán sai
    // theo hướng này thì người dùng thiếu một lựa chọn thanh toán; đoán sai theo
    // hướng kia thì app bị gỡ khỏi cửa hàng.
    return 'play';
  }

  /// Google Play Billing đã đủ cấu hình để bán chưa.
  private playBillingReady(): boolean {
    if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) return true;
    return (
      process.env.NODE_ENV !== 'production' &&
      process.env.MOCK_GOOGLE_PLAY === 'true'
    );
  }

  /// SePay đã đủ cấu hình để nhận tiền chưa.
  ///
  /// Đòi đủ **cả ba** biến tài khoản. Trước đây chúng có giá trị mặc định là số
  /// tài khoản cá nhân của một thành viên trong nhóm — thiếu cấu hình lúc lên
  /// thật thì tiền của khách chảy thẳng vào tài khoản đó mà không ai nhận ra.
  private sepayReady(): boolean {
    return Boolean(
      process.env.SEPAY_ACCOUNT_NUMBER &&
        process.env.SEPAY_BANK_CODE &&
        process.env.SEPAY_ACCOUNT_NAME,
    );
  }

  /// Danh sách cổng được phép hiện cho kênh phân phối này.
  gatewaysFor(channel: 'play' | 'direct' | 'web'): string[] {
    const out: string[] = [];
    if (channel === 'play') {
      if (this.playBillingReady()) out.push('GOOGLE_PLAY');
      if (process.env.USER_CHOICE_BILLING === 'true' && this.sepayReady()) {
        out.push('SEPAY');
      }
      return out;
    }
    // Ngoài CH Play thì Play Billing không tồn tại (không có thư viện billing để
    // gọi), nên chỉ còn chuyển khoản và ví.
    if (this.sepayReady()) out.push('SEPAY');
    out.push(...this.gateways.availableGateways());
    return out;
  }

  /// Bảng giá, các cổng đang mở, và mã sản phẩm Play tương ứng từng kỳ hạn.
  ///
  /// `channelHeader` lấy từ `X-Client-Channel`. Client khai được, nhưng khai sai
  /// cũng không mở thêm được đường nào: mọi cổng đều tự xác thực lại lúc thanh
  /// toán. Header này chỉ quyết định **bày cái gì**, không quyết định cho phép.
  plans(channelHeader?: string) {
    const channel = this.clientChannel(channelHeader);
    return {
      currency: 'VND',
      channel,
      gateways: this.gatewaysFor(channel),
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
          /// Mã sản phẩm để app gọi Play Billing. Giá hiển thị lúc mua là giá
          /// Google trả về, không phải con số này — Play tự quy đổi tiền tệ và
          /// tự cộng thuế theo nước của người mua.
          playProductId: playProductIdFor(plan, t.months),
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
    if (provider !== 'MOMO' && provider !== 'ZALOPAY' && provider !== 'SEPAY') {
      throw new BadRequestException({
        code: 'INVALID_PROVIDER',
        message: 'errors.premium.invalidProvider',
      });
    }
    const gateway = provider;
    // GOOGLE_PLAY cố tình KHÔNG có ở đây: Play Billing không tạo đơn phía mình.
    // Google giữ tiền, giữ giá, và trả về một biên lai — đường vào của nó là
    // `verifyGooglePlayPurchase`, không phải `createOrder`.
    const ready =
      gateway === 'SEPAY'
        ? this.sepayReady()
        : this.gateways.availableGateways().includes(gateway);
    if (!ready) {
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

    // SePay nhận diện đơn bằng **nội dung chuyển khoản** do người dùng gõ tay
    // hoặc do QR điền sẵn — mà ô đó ngắn và nhiều ngân hàng lọc mất dấu chấm.
    // Mã `tmsub.<uuid>.PLUS.12.<ts>` không lọt qua được, nên đơn SePay dùng mã
    // ngắn `TM######`. Nó vẫn là `orderId` của cùng bảng `PaymentOrder`, nên
    // toàn bộ đường xử lý phía sau (`fulfill`, lịch sử hoá đơn, dọn đơn treo)
    // dùng chung một lối, không phải nhánh riêng.
    const orderId =
      gateway === 'SEPAY'
        ? await this.newSepayOrderCode()
        : PremiumService.buildOrderId(userId, plan, m);
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
      // Giành lượt dùng mã TRƯỚC, cấp quyền SAU. Thứ tự cũ (cấp rồi mới ghi
      // lượt) cho phép N request song song cùng qua `validate()` khi chưa có
      // lượt nào được ghi, và mỗi request cộng thêm một kỳ premium. `redeem`
      // khoá dòng mã rồi đếm lại, nên chỉ đúng số lượt cho phép giành được.
      const claimed =
        appliedCode !== null &&
        (await this.promos.redeem({
          code: appliedCode,
          userId,
          orderId,
          discountApplied: discount,
        }));
      if (!claimed) {
        await this.prisma.paymentOrder.update({
          where: { orderId },
          data: { status: 'CANCELLED', failureReason: 'PROMO_ALREADY_USED' },
        });
        throw new BadRequestException({
          code: 'PROMO_ALREADY_USED',
          message: 'errors.promo.alreadyUsed',
        });
      }

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

    // SePay không phải cổng thanh toán mà là dịch vụ đọc biến động số dư ngân
    // hàng. Không có đơn nào để tạo ở phía họ — mình chỉ dựng mã QR trỏ vào tài
    // khoản của mình với nội dung là mã đơn, rồi chờ webhook báo tiền về.
    if (gateway === 'SEPAY') {
      return {
        orderId,
        orderCode: orderId,
        plan,
        months: m,
        amount,
        baseAmount,
        discount,
        promoCode: appliedCode,
        provider: gateway,
        ...this.sepayQr(orderId, Number(amount)),
      };
    }

    try {
      const created = await this.gateways.create({
        gateway: gateway,
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



  /// Xác thực biên lai Google Play và cấp quyền.
  ///
  /// Dùng **Subscriptions v2** (`purchases/subscriptionsv2/tokens/{token}`)
  /// thay vì v1. Khác biệt quan trọng: v2 tra cứu **chỉ bằng token**, và trả về
  /// mã sản phẩm thật trong `lineItems[].productId`. Nghĩa là gói và số tháng
  /// suy ra từ thứ Google xác nhận đã bán, **không phải** từ `productId` do
  /// client tự khai. Client chỉ còn cầm token — thứ nó không tự bịa được.
  async verifyGooglePlayPurchase(
    userId: string,
    token: string,
    productId?: string,
  ) {
    if (!token) {
      throw new BadRequestException({
        code: 'MISSING_TOKEN',
        message: 'errors.premium.missingPurchaseToken',
      });
    }

    if (this.play.configured()) {
      return this.verifyWithGoogle(userId, token, productId);
    }

    // ── Từ đây: CHƯA cấu hình Google (dev/test) ──────────────────────────
    // Biên lai đã dùng rồi thì trả về kết quả cũ, KHÔNG cộng thêm hạn.
    //
    // Chốt này phải đứng **trước** mọi nhánh cấp quyền, kể cả nhánh giả lập lúc
    // dev. Đặt nó sau thì đường giả lập đi vòng qua và mỗi lần gửi lại cùng một
    // biên lai lại cộng thêm một kỳ hạn — đúng lỗi đã tự tay tạo ra ở bản trước
    // và chỉ lộ ra khi gọi thật hai lần liên tiếp.
    //
    // Google gửi lại cùng một token nhiều lần một cách hoàn toàn bình thường:
    // app khôi phục giao dịch lúc khởi động, `restorePurchases()`, và mọi lần
    // cài lại máy. Không chặn ở đây thì mỗi lần mở app lại cộng thêm một kỳ hạn.
    const existingOrder =
      typeof this.prisma.paymentOrder?.findFirst === 'function'
        ? await this.prisma.paymentOrder.findFirst({
            where: { provider: 'GOOGLE_PLAY', externalId: token },
          })
        : null;
    if (existingOrder) {
      if (existingOrder.userId !== userId) {
        this.logger.warn(
          `Biên lai Play đã thuộc user khác: token dùng bởi ${existingOrder.userId}, nay ${userId} đòi`,
        );
        throw new BadRequestException({
          code: 'RECEIPT_ALREADY_USED',
          message: 'errors.premium.receiptAlreadyUsed',
        });
      }
      return {
        success: true,
        plan: existingOrder.plan,
        alreadyProcessed: true,
      };
    }

    const seen = await this.prisma.subscription.findFirst({
      where: { provider: 'GOOGLE_PLAY', externalId: token },
    });
    if (seen) {
      if (seen.userId !== userId) {
        // Cùng một biên lai không thể thuộc hai tài khoản. Đây là dấu hiệu
        // chia sẻ token để nhân bản gói.
        this.logger.warn(
          `Biên lai Play đã thuộc user khác: token dùng bởi ${seen.userId}, nay ${userId} đòi`,
        );
        throw new BadRequestException({
          code: 'RECEIPT_ALREADY_USED',
          message: 'errors.premium.receiptAlreadyUsed',
        });
      }
      return {
        success: true,
        plan: seen.plan,
        alreadyProcessed: true,
        currentPeriodEnd: seen.currentPeriodEnd,
      };
    }

    const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      if (
        process.env.NODE_ENV !== 'production' &&
        process.env.MOCK_GOOGLE_PLAY === 'true'
      ) {
        // Ở chế độ giả lập KHÔNG có Google để hỏi, nên đành tin `productId` —
        // nhưng vẫn bắt nó nằm trong danh mục, để mã sai lộ ra ngay lúc dev
        // chứ không phải lúc đã lên thật.
        const mock = playProductOf(productId);
        if (!mock) {
          throw new BadRequestException({
            code: 'UNKNOWN_PRODUCT',
            message: 'errors.premium.unknownProduct',
          });
        }
        this.logger.warn(
          `MOCK_GOOGLE_PLAY=true: cấp quyền giả lập user=${userId} prod=${productId}`,
        );
        const amount = priceOf(mock.plan, mock.months);
        const playOrderId = `play.mock.${token.slice(-16).replace(/[^a-zA-Z0-9]/g, '')}.${Date.now()}`;
        const runMockGrant = async (tx: any) => {
          await tx.paymentOrder.create({
            data: {
              orderId: playOrderId,
              userId,
              plan: mock.plan,
              months: mock.months,
              amount,
              baseAmount: amount,
              discountAmount: 0,
              provider: 'GOOGLE_PLAY',
              status: 'SUCCESS',
              externalId: token,
              paidAt: new Date(),
            },
          });
          await this.entitlements.grant({
            userId,
            plan: mock.plan,
            months: mock.months,
            provider: 'GOOGLE_PLAY',
            externalId: token,
            tx,
          });
        };

        if (typeof this.prisma.$transaction === 'function') {
          await this.prisma.$transaction(runMockGrant);
        } else {
          await runMockGrant(this.prisma);
        }

        return {
          success: true,
          plan: mock.plan,
          months: mock.months,
          mocked: true,
        };
      }
      this.logger.warn(
        `Chưa cấu hình xác thực Google Play — từ chối: user=${userId}`,
      );
      throw new ServiceUnavailableException({
        code: 'VERIFY_NOT_CONFIGURED',
        message: 'errors.premium.verifyNotConfigured',
      });
    }

    // Không tới được đây: nhánh trên luôn trả về hoặc ném. Có cấu hình thì
    // đã rẽ sang `verifyWithGoogle` từ đầu hàm.
    throw new ServiceUnavailableException({
      code: 'VERIFY_NOT_CONFIGURED',
      message: 'errors.premium.verifyNotConfigured',
    });
  }

  /// Xác thực biên lai với Google thật và chép trạng thái về.
  ///
  /// Khác bản cũ ở chỗ biên lai **đã thấy** không còn trả "đã xử lý" ngay: gói
  /// Play giữ nguyên token qua mọi kỳ gia hạn, nên mỗi lần app khôi phục giao
  /// dịch là một lần tra lại Google và cập nhật hạn. Đó là đường gia hạn dự
  /// phòng khi RTDN chưa cấu hình hoặc bị lỡ.
  private async verifyWithGoogle(
    userId: string,
    token: string,
    productId?: string,
  ) {
    // Biên lai đã thuộc tài khoản khác thì dừng trước khi gọi Google.
    const owner =
      (await this.prisma.subscription.findFirst({
        where: { provider: 'GOOGLE_PLAY', externalId: token },
        select: { userId: true },
      })) ??
      (await this.prisma.paymentOrder.findFirst({
        where: { provider: 'GOOGLE_PLAY', externalId: token },
        select: { userId: true },
      }));
    if (owner && owner.userId !== userId) {
      this.logger.warn(
        `Biên lai Play đã thuộc user khác: token dùng bởi ${owner.userId}, nay ${userId} đòi`,
      );
      throw new BadRequestException({
        code: 'RECEIPT_ALREADY_USED',
        message: 'errors.premium.receiptAlreadyUsed',
      });
    }

    let data: PlaySubscriptionV2;
    try {
      data = await this.play.fetchSubscription(token);
    } catch (err: any) {
      if (err instanceof PlayReceiptRejected) {
        this.logger.error(
          `Google từ chối tra biên lai (${err.status}): ${err.message}`,
        );
        throw new BadRequestException({
          code: 'RECEIPT_INVALID',
          message: 'errors.premium.receiptInvalid',
        });
      }
      // Không gọi được Google KHÁC với biên lai giả. Trả 503 để client biết
      // đường thử lại; trả 400 thì app coi như hỏng hẳn và vứt luôn biên lai
      // hợp lệ mà người dùng đã trả tiền.
      this.logger.error(`Không tra được biên lai Play: ${err?.message}`);
      throw new ServiceUnavailableException({
        code: 'VERIFY_UNREACHABLE',
        message: 'errors.premium.verifyUnreachable',
      });
    }

    // Ràng biên lai vào đúng tài khoản đã bấm mua.
    //
    // App truyền `applicationUserName` khi mở luồng mua, Google lưu lại thành
    // `obfuscatedExternalAccountId`. Thiếu bước này thì một biên lai mua bằng
    // tài khoản Google bất kỳ đều đổi được thành Premium cho bất kỳ tài khoản
    // TripMate nào — chỉ cần gửi token sang.
    const boundTo =
      data?.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (boundTo && boundTo !== userId) {
      this.logger.warn(
        `Biên lai Play gắn với tài khoản ${boundTo}, không phải ${userId}`,
      );
      throw new BadRequestException({
        code: 'RECEIPT_ACCOUNT_MISMATCH',
        message: 'errors.premium.receiptAccountMismatch',
      });
    }

    // Mã sản phẩm THẬT, do Google trả về.
    const realProductId = data?.lineItems?.[0]?.productId;
    const product = playProductOf(realProductId);
    if (!product) {
      // Sản phẩm có thật trên Play nhưng server chưa khai — thiếu sót cấu hình
      // của mình, không phải lỗi người mua. Ghi rõ để sửa nhanh.
      this.logger.error(
        `Biên lai Play hợp lệ nhưng sản phẩm "${realProductId}" không có trong PLAY_PRODUCTS`,
      );
      throw new ServiceUnavailableException({
        code: 'PRODUCT_NOT_MAPPED',
        message: 'errors.premium.productNotMapped',
      });
    }
    if (productId && productId !== realProductId) {
      // Không chặn — Google mới là bên nói đúng, và mình đã dùng số của Google.
      // Nhưng lệch thì đáng ghi lại: hoặc client có lỗi, hoặc ai đó đang dò.
      this.logger.warn(
        `Client khai productId="${productId}" nhưng Google nói "${realProductId}" (user=${userId})`,
      );
    }

    // Chép trạng thái về TRƯỚC khi kết luận: biên lai đã hết hạn/bị treo cũng
    // phải hạ quyền phía mình xuống cho khớp, rồi mới báo "không dùng được".
    const result = await this.play.apply(userId, token, data, 'google_play');
    if (!GooglePlayBillingService.isUsable(data?.subscriptionState) || !result) {
      this.logger.warn(
        `Biên lai Play chưa dùng được: state=${data?.subscriptionState}`,
      );
      throw new BadRequestException({
        code: 'RECEIPT_NOT_ACTIVE',
        message: 'errors.premium.receiptNotActive',
      });
    }

    if (result.created && (this.prisma as any).notification?.create) {
      await (this.prisma as any).notification.create({
        data: {
          userId,
          type: 'PAYMENT_RECEIVED',
          title: 'Nâng cấp thành công qua Google Play',
          body: `Gói ${product.plan === 'SQUAD' ? 'Squad Pass' : 'TripMate+'} (${product.months} tháng) của bạn đã được kích hoạt!`,
          data: {
            provider: 'GOOGLE_PLAY',
            plan: product.plan,
            months: product.months,
          },
        },
      });
    }

    // Xác nhận đã giao hàng — sau khi đã cấp. Xem `GooglePlayBillingService.acknowledge`.
    if (data?.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      await this.play.acknowledge(realProductId as string, token);
    }

    this.logger.log(
      `Google Play: ${result.created ? 'cấp' : 'đồng bộ'} ${product.plan} tới ${result.currentPeriodEnd.toISOString()} cho user=${userId} (product=${realProductId})`,
    );
    return {
      success: true,
      plan: product.plan,
      months: product.months,
      currentPeriodEnd: result.currentPeriodEnd,
      alreadyProcessed: !result.created && !result.newPeriod,
    };
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

  /// Trạng thái một đơn của **chính người đang hỏi**.
  ///
  /// Màn QR gọi hàm này vài giây một lần trong lúc chờ tiền về.
  ///
  /// Bản trước gọi thẳng sang `getPublicOrderStatus(orderCode)` và **vứt bỏ
  /// `userId`** — endpoint có đăng nhập nhưng không dùng danh tính để làm gì,
  /// nên ai cũng tra được đơn của người khác. Nay lọc theo `userId`, và đơn của
  /// người khác trả về `NOT_FOUND` y như đơn không tồn tại: phân biệt hai
  /// trường hợp đó là tự xác nhận mã đơn nào có thật.
  async getOrderStatus(userId: string, orderCode: string) {
    const order = await this.prisma.paymentOrder.findFirst({
      where: { orderId: orderCode, userId },
    });
    if (!order) return { status: 'NOT_FOUND', isPaid: false };
    return {
      orderCode,
      status: order.status,
      isPaid: order.status === 'SUCCESS',
      plan: order.plan,
      months: order.months,
      amount: Number(order.amount),
      paidAt: order.paidAt,
    };
  }

  /// Trạng thái đơn **không cần đăng nhập** — dùng cho trang web người dùng bị
  /// ví đẩy về sau khi trả tiền, lúc đó chưa chắc còn phiên đăng nhập.
  ///
  /// Trả về đúng một bit: đã trả tiền hay chưa. Không kèm số tiền, không kèm
  /// gói, không kèm mã người dùng. Endpoint này không có guard và lại
  /// `@SkipThrottle`, nên bất cứ thứ gì trả ra đây đều là thứ dò được hàng loạt
  /// bằng cách thử mã đơn. Bản trước trả cả số tiền.
  async getPublicOrderStatus(orderCode: string) {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId: orderCode },
      select: { status: true },
    });
    if (!order) return { status: 'NOT_FOUND', isPaid: false };
    return { orderCode, status: order.status, isPaid: order.status === 'SUCCESS' };
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

  /// Mã đơn ngắn cho SePay, dạng `TM` + 6 ký tự.
  ///
  /// Bảng chữ cái bỏ `0 O 1 I` — người dùng phải **đọc mã này và gõ tay** vào ô
  /// nội dung chuyển khoản khi quét QR bằng app ngân hàng không tự điền được.
  /// Nhầm số 0 với chữ O là tiền vào tài khoản mà không đơn nào khớp.
  ///
  /// Dùng `randomInt` của `crypto` chứ không phải `Math.random()`: mã đơn quyết
  /// định gói nào được cấp cho ai, nên nó là giá trị nhạy cảm. Với `Math.random()`
  /// người ta đoán được mã đơn của người khác từ mã của chính mình và chiếm
  /// khoản chuyển tiền đang chờ.
  private async newSepayOrderCode(): Promise<string> {
    const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    // Va chạm là chuyện thật: 32^6 ≈ 1 tỉ mã, nhưng chỉ cần trùng với MỘT đơn
    // còn treo là `orderId @unique` ném P2002 giữa lúc người dùng đang mua.
    for (let attempt = 0; attempt < 5; attempt++) {
      let code = 'TM';
      for (let i = 0; i < 6; i++) {
        code += ALPHABET[randomInt(ALPHABET.length)];
      }
      const taken = await this.prisma.paymentOrder.findUnique({
        where: { orderId: code },
        select: { id: true },
      });
      if (!taken) return code;
    }
    throw new ServiceUnavailableException({
      code: 'ORDER_CODE_EXHAUSTED',
      message: 'errors.premium.orderCodeExhausted',
    });
  }

  /// Mã QR VietQR trỏ vào tài khoản nhận tiền, nội dung là mã đơn.
  ///
  /// Không có giá trị mặc định cho số tài khoản. Bản trước mặc định về số tài
  /// khoản cá nhân của một thành viên trong nhóm, nghĩa là quên đặt biến môi
  /// trường lúc lên thật thì tiền của khách chảy vào đó và không ai biết cho
  /// tới lúc đối soát. Thiếu cấu hình phải là **không bán được**, không phải là
  /// bán vào nhầm túi.
  private sepayQr(orderCode: string, amount: number) {
    const accountNumber = process.env.SEPAY_ACCOUNT_NUMBER;
    const bankCode = process.env.SEPAY_BANK_CODE;
    const accountName = process.env.SEPAY_ACCOUNT_NAME;
    if (!accountNumber || !bankCode || !accountName) {
      this.logger.error(
        'Thiếu SEPAY_ACCOUNT_NUMBER/SEPAY_BANK_CODE/SEPAY_ACCOUNT_NAME — không dựng được QR',
      );
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }
    const acc = encodeURIComponent(accountNumber);
    const bank = encodeURIComponent(bankCode);
    const des = encodeURIComponent(orderCode);
    return {
      payUrl: `https://qr.sepay.vn/gateway?acc=${acc}&bank=${bank}&amount=${amount}&des=${des}`,
      qrUrl: `https://qr.sepay.vn/img?acc=${acc}&bank=${bank}&amount=${amount}&des=${des}&template=compact`,
      vietqrUrl: `https://vietqr.app/img?bank=${bank}&acc=${acc}&amount=${amount}&des=${des}&template=compact&showinfo=true&holder=${encodeURIComponent(accountName)}`,
      bankInfo: {
        bankCode,
        accountNumber,
        accountName,
        amount,
        transferContent: orderCode,
      },
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

  /// Webhook SePay — báo biến động số dư tài khoản ngân hàng.
  ///
  /// SePay không phải cổng thanh toán: nó chỉ đọc thông báo của ngân hàng rồi
  /// gọi sang đây. Nghĩa là **không có chữ ký nào để kiểm** — chỉ có một token
  /// dùng chung ở header. Token đó vì thế là toàn bộ hàng rào: lộ nó ra là bất
  /// kỳ ai cũng tự cấp Premium cho mình bằng một request rỗng.
  ///
  /// Bản trước để sẵn giá trị mặc định `'MY_SEPAY_SECRET_0406'` trong mã nguồn.
  /// Một bí mật nằm trong repo thì không còn là bí mật, và nó lại còn là giá
  /// trị **mặc định** — quên đặt biến môi trường là chạy thẳng với cái token ai
  /// cũng đọc được. Nay thiếu cấu hình thì từ chối nhận webhook.
  async handleSepayWebhook(payload: any, authHeader?: string) {
    const expectedToken = process.env.SEPAY_WEBHOOK_TOKEN;
    if (!expectedToken) {
      this.logger.error('Thiếu SEPAY_WEBHOOK_TOKEN — từ chối webhook SePay');
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }

    // Chấp nhận cả `Authorization: Apikey <token>` lẫn token trần ở `X-Api-Key`.
    const parts = (authHeader ?? '').trim().split(' ');
    const providedToken =
      parts.length > 1 ? parts.slice(1).join(' ').trim() : parts[0].trim();
    if (!providedToken || !this.safeEqual(expectedToken, providedToken)) {
      this.logger.warn('Webhook SePay sai token xác thực');
      throw new BadRequestException('errors.premium.badSignature');
    }

    // Tiền đi RA khỏi tài khoản thì không liên quan gì tới đơn hàng.
    if (payload?.transferType === 'out') {
      return { success: true, message: 'Ignored outbound transaction' };
    }

    // Mã đơn nằm trong nội dung chuyển khoản. Ngân hàng thường viết hoa toàn bộ
    // và chèn thêm chữ, nên phải dò chứ không so bằng.
    let orderCode = String(payload?.code || '').trim().toUpperCase();
    if (!orderCode.startsWith('TM')) {
      const content = String(payload?.content || '').toUpperCase();
      const match = content.match(/TM[2-9A-HJ-NP-Z]{6}/);
      orderCode = match ? match[0] : '';
    }
    if (!orderCode) {
      // Người khác chuyển tiền vào tài khoản vì lý do không liên quan là chuyện
      // bình thường. Trả 200 để SePay thôi gửi lại.
      this.logger.log(
        `Bỏ qua giao dịch SePay ${payload?.id}: không có mã đơn trong "${payload?.content}"`,
      );
      return { success: true, message: 'No TripMate order code found' };
    }

    const transferAmount = Number(
      payload?.transferAmount ?? payload?.amount ?? 0,
    );
    // NaN lọt qua mọi phép so sánh `<` / `!==` bên dưới thành "khớp tiền".
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
      this.logger.warn(`SePay: số tiền không hợp lệ cho đơn ${orderCode}`);
      return { success: true, message: 'Invalid transfer amount' };
    }
    const externalId = String(
      payload?.id ?? payload?.referenceCode ?? orderCode,
    );

    // Đi chung `fulfill()` với Momo/ZaloPay: giành quyền xử lý bằng một lệnh
    // cập nhật nguyên tử, đối chiếu số tiền, chống cấp trùng, ghi lượt dùng mã
    // giảm giá, đóng lần dùng thử. Trước đây nhánh SePay tự làm lại tất cả
    // những việc đó bằng tay và làm thiếu: đọc `plan`/`months` từ chuỗi JSON
    // nhét trong trường ghi chú, không có bước giành quyền nên hai webhook về
    // cùng lúc là cộng hạn hai lần, và ghi vào bảng `PaymentTransaction` mà
    // lịch sử hoá đơn không hề đọc tới — người trả tiền bằng QR không bao giờ
    // thấy hoá đơn của mình.
    //
    // `allowOverpay`: chuyển khoản là gõ tay, trả thừa vài nghìn thì vẫn giao.
    await this.fulfill(orderCode, 'SEPAY', externalId, transferAmount, true);

    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId: orderCode },
      select: { status: true },
    });
    return { success: order?.status === 'SUCCESS', orderCode };
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
    provider: 'MOMO' | 'ZALOPAY' | 'SEPAY',
    externalId: string,
    paidAmount?: number,
    /// Cho phép trả DƯ. Chuyển khoản ngân hàng thì người ta gõ tay số tiền, trả
    /// thừa vài nghìn là chuyện thường và không có lý do gì để từ chối giao
    /// hàng. Ví điện tử thì số tiền do cổng chốt nên phải khớp tuyệt đối.
    allowOverpay = false,
  ) {
    if (!orderId) {
      this.logger.warn('Bỏ qua IPN: không có mã đơn');
      return;
    }

    // Đơn phải tồn tại. Trước đây không có bảng đơn nào, nên `fulfill` chỉ còn
    // biết tin vào chính mã đơn — mà mã đơn tự mang `plan` và `months`. Ai dựng
    // được một giao dịch 1.000đ mang mã `tmsub.<id>.SQUAD.12` là nhận trọn một
    // năm Squad.
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId: orderId },
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
    const expectedAmount = Number(order.amount);
    const amountWrong =
      paidAmount !== undefined &&
      (!Number.isFinite(paidAmount) ||
        (allowOverpay
          ? paidAmount < expectedAmount
          : paidAmount !== expectedAmount));
    if (amountWrong) {
      this.logger.error(
        `IPN sai số tiền: đơn ${orderId} cần ${order.amount.toString()}, cổng báo ${paidAmount}`,
      );
      // Chuyển khoản trả thiếu thì **giữ đơn ở PENDING**, không đánh hỏng.
      //
      // Ví điện tử chốt số tiền trong link thanh toán, nên lệch số tiền ở đó là
      // dấu hiệu có người sửa giữa đường — đóng đơn lại là đúng. Còn chuyển
      // khoản ngân hàng thì người dùng **gõ tay số tiền**, và gõ thiếu một số 0
      // là chuyện xảy ra thật. Đánh đơn thành FAILED lúc đó nghĩa là tiền đã ra
      // khỏi tài khoản của họ mà mã đơn thì chết hẳn, chuyển bù thêm cũng không
      // cứu được. Để PENDING thì lần chuyển đúng số tiếp theo vẫn hoàn tất được
      // chính đơn đó.
      if (!allowOverpay) {
        await this.prisma.paymentOrder.update({
          where: { orderId: order.orderId },
          data: {
            status: 'FAILED',
            failureReason: 'AMOUNT_MISMATCH',
            externalId,
          },
        });
      }
      return;
    }

    // Đơn còn giữ nguyên `plan`/`months` chốt lúc tạo. Dùng chúng, không dùng
    // giá trị đọc từ mã đơn: mã đơn đi qua tay cổng, còn dòng này thì không.
    if (order.plan === 'FREE') {
      this.logger.error(`Đơn ${orderId} mang gói FREE — bỏ qua`);
      return;
    }

    // 1. Kiểm tra đối soát idempotency lịch sử qua PaymentOrder:
    // Tránh mất dấu idempotency khi người dùng gia hạn nhiều lần (khiến externalId trong Subscription bị ghi đè).
    const existingOrder =
      typeof this.prisma.paymentOrder?.findFirst === 'function'
        ? await this.prisma.paymentOrder.findFirst({
            where: { provider, externalId, status: 'SUCCESS' },
          })
        : null;
    if (existingOrder) {
      if (existingOrder.userId === order.userId) {
        // Giao dịch này đã trả cho đơn KHÁC (đơn hiện tại còn PENDING, nên
        // không phải cùng đơn gọi lại). Không đánh đơn này thành SUCCESS: nó
        // chưa nhận đồng nào, đánh vào là hoá đơn báo "đã trả" mà không có gói.
        this.logger.warn(
          `Mã giao dịch ${provider}/${externalId} đã dùng cho đơn ${existingOrder.orderId} — giữ đơn ${order.orderId} ở PENDING`,
        );
        return;
      }
      this.logger.error(
        `Mã giao dịch ${provider}/${externalId} đã thuộc về người khác — từ chối đơn ${order.orderId}`,
      );
      await this.prisma.paymentOrder.update({
        where: { orderId: order.orderId },
        data: { status: 'FAILED', failureReason: 'EXTERNAL_ID_CONFLICT' },
      });
      return;
    }

    // 2. `@@unique([provider, externalId])` ở tầng database chặn cấp trùng khi
    // cổng gọi lại webhook bằng một mã đơn khác cho cùng giao dịch.
    const existing = await this.prisma.subscription.findFirst({
      where: { provider, externalId },
    });
    if (existing) {
      // Cùng người dùng: đây là lần gọi lại của chính giao dịch đó, đóng đơn
      // và thôi.
      if (existing.userId === order.userId) {
        // Như trên: giao dịch đã cấp gói cho một đơn khác, đơn này chưa nhận
        // tiền nên để nguyên PENDING.
        this.logger.warn(
          `Mã giao dịch ${provider}/${externalId} đã cấp gói trước đó — giữ đơn ${order.orderId} ở PENDING`,
        );
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

    const runFulfillTx = async (tx: Prisma.TransactionClient) => {
      // Giành quyền xử lý bằng atomic update (chuyển PENDING -> SUCCESS trước khi
      // thực hiện side-effects). Vì enum PaymentStatus không có 'PROCESSING', việc
      // cập nhật có điều kiện `where: { status: 'PENDING' }` tận dụng cơ chế khóa
      // hàng (row-level lock) của database để đảm bảo chỉ đúng MỘT tiến trình
      // giành được quyền xử lý, loại bỏ hoàn toàn race condition check-then-act.
      const claimed = await tx.paymentOrder.updateMany({
        where: { orderId: order.orderId, status: 'PENDING' },
        data: { status: 'SUCCESS', externalId, paidAt: new Date() },
      });
      if (claimed.count === 0) {
        this.logger.log(
          `IPN trùng hoặc đơn đang được xử lý bởi tiến trình khác: ${orderId}`,
        );
        return;
      }

      await this.entitlements.grant({
        userId: order.userId,
        plan: order.plan as PaidPlan,
        months: order.months,
        provider,
        externalId,
        tx,
      });

      // Ghi lượt dùng mã giảm giá — chỉ ở đây, khi tiền đã thật sự vào.
      if (order.promoCode && Number(order.discountAmount) > 0) {
        await this.promos.redeem({
          code: order.promoCode,
          userId: order.userId,
          orderId: order.orderId,
          discountApplied: Number(order.discountAmount),
          tx,
        });
      }

      // Mua trong lúc còn dùng thử: đóng lần dùng thử lại với kết cục CONVERTED
      await this.trials.markConverted(order.userId, tx);

      await this.trials.log(
        order.userId,
        'SUBSCRIPTION_GRANTED',
        {
          actor: `webhook:${provider}`,
          toStatus: 'ACTIVE',
          plan: order.plan,
          meta: { orderId: order.orderId, externalId, months: order.months },
        },
        tx,
      );

      // In-App Notification (Outbox Pattern)
      if ((tx as any).notification?.create) {
        await (tx as any).notification.create({
          data: {
            userId: order.userId,
            type: 'PAYMENT_RECEIVED',
            title: 'Nâng cấp gói thành công',
            body: `Gói ${order.plan === 'SQUAD' ? 'Squad Pass' : 'TripMate+'} (${order.months} tháng) của bạn đã được kích hoạt!`,
            data: { orderId: order.orderId, provider, plan: order.plan, months: order.months },
          },
        });
      }

      this.logger.log(
        `Đã cấp ${order.plan} ${order.months} tháng cho ${order.userId} qua ${provider}`,
      );
    };

    if (typeof this.prisma.$transaction === 'function') {
      try {
        await this.prisma.$transaction(runFulfillTx);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Transaction thất bại khi cấp quyền cho đơn ${order.orderId}, database tự động rollback: ${message}`,
          stack,
        );
        throw error;
      }
    } else {
      // Fallback cho môi trường unit test khi prisma mock không cung cấp $transaction
      try {
        await runFulfillTx(this.prisma);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
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
