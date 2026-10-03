import { Injectable, Logger } from '@nestjs/common';
import { Plan, Prisma, SubStatus } from '@prisma/client';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../prisma/prisma.service';
import { TrialService } from './trial.service';
import { playProductOf } from './google-play';
import { priceOf } from './pricing';

/** Phần payload `purchases.subscriptionsv2.get` mà ta dùng. */
export interface PlaySubscriptionV2 {
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  lineItems?: { productId?: string; expiryTime?: string }[];
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

/** Google trả lỗi cho biên lai (4xx) — khác với không gọi được Google. */
export class PlayReceiptRejected extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export interface ApplyResult {
  /** Lần đầu thấy biên lai này (cấp mới), không phải đồng bộ lại. */
  created: boolean;
  /** Có thêm một kỳ thanh toán mới (mua mới hoặc gia hạn). */
  newPeriod: boolean;
  status: SubStatus;
  plan: Exclude<Plan, 'FREE'>;
  months: number;
  currentPeriodEnd: Date;
}

/**
 * Giữ gói Google Play khớp với Google.
 *
 * Gói Play tự gia hạn và **giữ nguyên `purchaseToken` qua mọi kỳ**. Bản trước
 * cấp `N tháng` một lần rồi coi token là "đã xử lý" — nên kỳ thứ hai người
 * dùng trả tiền mà server không cộng gì, quyền hết đúng sau một tháng. Huỷ hay
 * hoàn tiền cũng không về tới server.
 *
 * Giờ server không tự tính hạn cho gói Play nữa: `currentPeriodEnd` và trạng
 * thái **chép từ Google** mỗi lần đồng bộ. Có hai đường vào:
 *   - App gửi biên lai (mua mới, hoặc `restorePurchases()` lúc mở app).
 *   - RTDN: Google báo qua Pub/Sub mỗi khi gói đổi (gia hạn, huỷ, treo, hết
 *     hạn, thu hồi, hoàn tiền) — kể cả khi người dùng không mở app.
 *
 * Mỗi biên lai Play là một dòng `subscriptions` riêng, không gộp vào gói trả
 * bằng kênh khác: Google là bên giữ hạn của nó, gộp vào thì một lần đồng bộ sẽ
 * ghi đè mất số ngày người dùng đã trả qua SePay. Quyền lấy theo dòng còn hạn
 * xa nhất, nên nhiều dòng không sao.
 */
@Injectable()
export class GooglePlayBillingService {
  private readonly logger = new Logger(GooglePlayBillingService.name);
  private auth: GoogleAuth | null | undefined;
  private oidc = new OAuth2Client();

  constructor(
    private prisma: PrismaService,
    private trials: TrialService,
  ) {}

  static packageName(): string {
    return process.env.ANDROID_PACKAGE_NAME || 'com.tripmate.app';
  }

  configured(): boolean {
    return !!this.client();
  }

  // ── Gọi Google ─────────────────────────────────────────────────────────

  /** Tra biên lai. Ném `PlayReceiptRejected` nếu Google trả 4xx. */
  async fetchSubscription(token: string): Promise<PlaySubscriptionV2> {
    const client = this.client();
    if (!client) throw new Error('NOT_CONFIGURED');
    const pkg = GooglePlayBillingService.packageName();
    const res = await client.request<PlaySubscriptionV2>({
      url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`,
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status >= 400 && res.status < 500) {
      throw new PlayReceiptRejected(
        res.status,
        JSON.stringify((res.data as any)?.error ?? res.data),
      );
    }
    if (res.status >= 500) throw new Error(`Google ${res.status}`);
    return res.data;
  }

  /**
   * Báo Google "đã giao hàng". **Bắt buộc**: biên lai không được acknowledge
   * trong 3 ngày sẽ bị Google tự hoàn tiền và huỷ gói. Nuốt lỗi — gói đã cấp
   * rồi, ném ra ở đây chỉ làm khách tưởng chưa mua được.
   */
  async acknowledge(productId: string, token: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    const pkg = GooglePlayBillingService.packageName();
    try {
      const res = await client.request({
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
        method: 'POST',
        data: {},
        timeout: 10000,
        validateStatus: () => true,
      });
      if (res.status >= 300) {
        this.logger.error(
          `Acknowledge biên lai Play thất bại (${res.status}) — Google sẽ hoàn tiền sau 3 ngày nếu không xử lý`,
        );
      }
    } catch (e) {
      this.logger.error(`Acknowledge biên lai Play lỗi: ${String(e)}`);
    }
  }

  // ── Đồng bộ trạng thái ──────────────────────────────────────────────────

  /**
   * Trạng thái Google → trạng thái của mình.
   *
   * - ACTIVE / IN_GRACE_PERIOD: còn quyền tới `expiryTime`. Grace period là
   *   lúc Google đang thử trừ tiền lại — người dùng chưa mất gì.
   * - CANCELED: người dùng tắt gia hạn nhưng **vẫn còn quyền tới hết kỳ** đã
   *   trả. Cắt ngay là lấy của họ thứ họ đã mua.
   * - ON_HOLD / PAUSED: trừ tiền thất bại hết grace, hoặc người dùng tạm
   *   dừng. Mất quyền nhưng gói chưa chết — Google có thể kích hoạt lại.
   * - EXPIRED: hết. Hạn không được nằm ở tương lai.
   * - PENDING (chờ thanh toán) và trạng thái lạ: không đổi gì.
   */
  static mapState(
    state: string | undefined,
    expiry: Date,
    now: Date,
  ): { status: SubStatus; cancelAtPeriodEnd: boolean; end: Date } | null {
    switch (state) {
      case 'SUBSCRIPTION_STATE_ACTIVE':
      case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
        return { status: 'ACTIVE', cancelAtPeriodEnd: false, end: expiry };
      case 'SUBSCRIPTION_STATE_CANCELED':
        return { status: 'ACTIVE', cancelAtPeriodEnd: true, end: expiry };
      case 'SUBSCRIPTION_STATE_ON_HOLD':
      case 'SUBSCRIPTION_STATE_PAUSED':
        return { status: 'PAST_DUE', cancelAtPeriodEnd: false, end: expiry };
      case 'SUBSCRIPTION_STATE_EXPIRED':
        return {
          status: 'EXPIRED',
          cancelAtPeriodEnd: false,
          end: expiry < now ? expiry : now,
        };
      default:
        return null;
    }
  }

  /** Còn dùng được để cấp quyền ngay không. */
  static isUsable(state: string | undefined): boolean {
    return (
      state === 'SUBSCRIPTION_STATE_ACTIVE' ||
      state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ||
      state === 'SUBSCRIPTION_STATE_CANCELED'
    );
  }

  /** Hạn xa nhất trong các dòng sản phẩm. */
  static expiryOf(data: PlaySubscriptionV2): Date | null {
    const times = (data.lineItems ?? [])
      .map((l) => Date.parse(l.expiryTime ?? ''))
      .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.max(...times)) : null;
  }

  /**
   * Chép trạng thái Google vào dòng `subscriptions` của biên lai này.
   *
   * Gọi khi đã chắc `userId` là chủ biên lai (đã kiểm ở lớp gọi). Trả `null`
   * khi không có gì để ghi (trạng thái chờ, thiếu hạn, sản phẩm lạ).
   */
  async apply(
    userId: string,
    token: string,
    data: PlaySubscriptionV2,
    actor: string,
  ): Promise<ApplyResult | null> {
    const productId = data.lineItems?.[0]?.productId;
    const product = playProductOf(productId);
    const expiry = GooglePlayBillingService.expiryOf(data);
    const now = new Date();
    const mapped = expiry
      ? GooglePlayBillingService.mapState(data.subscriptionState, expiry, now)
      : null;
    if (!product || !mapped) return null;

    const run = async (tx: Prisma.TransactionClient) => {
      // Nâng/hạ gói hoặc đăng ký lại sinh token MỚI kèm `linkedPurchaseToken`
      // trỏ về token cũ: nối vào đúng dòng cũ thay vì đẻ thêm một gói.
      let row = await tx.subscription.findFirst({
        where: { provider: 'GOOGLE_PLAY', externalId: token },
      });
      if (!row && data.linkedPurchaseToken) {
        row = await tx.subscription.findFirst({
          where: {
            provider: 'GOOGLE_PLAY',
            externalId: data.linkedPurchaseToken,
            userId,
          },
        });
      }

      const fields = {
        plan: product.plan,
        seats: product.plan === 'SQUAD' ? 5 : 1,
        status: mapped.status,
        currentPeriodEnd: mapped.end,
        cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
        canceledAt: mapped.cancelAtPeriodEnd ? (row?.canceledAt ?? now) : null,
        externalId: token,
      };
      const created = !row;
      const before = row?.status;
      const saved = row
        ? await tx.subscription.update({ where: { id: row.id }, data: fields })
        : await tx.subscription.create({
            data: {
              userId,
              provider: 'GOOGLE_PLAY',
              currentPeriodStart: now,
              ...fields,
            },
          });

      // Một kỳ thanh toán = một `latestOrderId` của Google (GPA.xxx, GPA.xxx..0,
      // GPA.xxx..1…). Ghi mỗi kỳ một hoá đơn, khoá theo mã đơn nên đồng bộ
      // lại bao nhiêu lần cũng không trùng.
      let newPeriod = false;
      if (
        data.latestOrderId &&
        GooglePlayBillingService.isUsable(data.subscriptionState)
      ) {
        const orderId = `play.${data.latestOrderId}`;
        const exists = await tx.paymentOrder.findUnique({ where: { orderId } });
        if (!exists) {
          const amount = priceOf(product.plan, product.months);
          await tx.paymentOrder.create({
            data: {
              orderId,
              userId,
              plan: product.plan,
              months: product.months,
              amount,
              baseAmount: amount,
              discountAmount: 0,
              provider: 'GOOGLE_PLAY',
              status: 'SUCCESS',
              externalId: token,
              paidAt: now,
            },
          });
          newPeriod = true;
        }
      }

      if (created || newPeriod || before !== mapped.status) {
        await this.trials.log(
          userId,
          created
            ? 'SUBSCRIPTION_GRANTED'
            : newPeriod
              ? 'SUBSCRIPTION_RENEWED'
              : 'SUBSCRIPTION_STATE_CHANGED',
          {
            actor,
            fromStatus: before,
            toStatus: mapped.status,
            plan: product.plan,
            meta: {
              state: data.subscriptionState,
              orderId: data.latestOrderId,
              until: mapped.end.toISOString(),
            },
          },
          tx,
        );
      }
      if (mapped.status === 'ACTIVE') {
        await this.trials.markConverted(userId, tx);
      }

      return {
        created,
        newPeriod,
        status: saved.status,
        plan: product.plan,
        months: product.months,
        currentPeriodEnd: saved.currentPeriodEnd,
      };
    };

    try {
      return await this.prisma.$transaction(run);
    } catch (err: any) {
      // App gửi biên lai và RTDN về cùng lúc cho một lần mua mới: cả hai cùng
      // thấy "chưa có dòng" và cùng tạo. Ràng buộc unique chặn một bên — chạy
      // lại thì bên đó thành đường cập nhật.
      if (err?.code === 'P2002') return this.prisma.$transaction(run);
      throw err;
    }
  }

  /**
   * Thu hồi ngay: hoàn tiền / chargeback (voidedPurchaseNotification) hoặc
   * Google báo REVOKED. Khác "huỷ gia hạn": tiền đã trả lại, nên quyền cũng
   * phải mất ngay chứ không giữ tới hết kỳ.
   */
  async revoke(token: string, actor: string, orderId?: string) {
    const row = await this.prisma.subscription.findFirst({
      where: { provider: 'GOOGLE_PLAY', externalId: token },
    });
    if (!row) return false;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: row.id },
        data: {
          status: 'CANCELED',
          currentPeriodEnd: row.currentPeriodEnd < now ? row.currentPeriodEnd : now,
          cancelAtPeriodEnd: false,
          canceledAt: now,
        },
      });
      // Ghế Squad cấp từ gói này mất theo nhờ điều kiện `status: ACTIVE` ở
      // EntitlementService — không cần thu hồi từng ghế.
      await tx.paymentOrder.updateMany({
        where: orderId
          ? { orderId: `play.${orderId}` }
          : { provider: 'GOOGLE_PLAY', externalId: token, status: 'SUCCESS' },
        data: { status: 'REFUNDED' },
      });
      await this.trials.log(
        row.userId,
        'SUBSCRIPTION_REVOKED',
        {
          actor,
          fromStatus: row.status,
          toStatus: 'CANCELED',
          plan: row.plan,
          meta: { orderId },
        },
        tx,
      );
    });
    this.logger.warn(`Thu hồi gói Play của user=${row.userId} (${actor})`);
    return true;
  }

  // ── RTDN ────────────────────────────────────────────────────────────────

  /**
   * Xác thực request đẩy từ Pub/Sub.
   *
   * Push subscription bật "authentication" thì mỗi request kèm một OIDC token
   * do Google ký, `aud` là chuỗi mình đặt và `email` là service account mình
   * chọn. Không có cấu hình thì TỪ CHỐI hết: endpoint này thu hồi được quyền
   * của bất kỳ ai, để ngỏ là ai cũng gửi được "hoàn tiền".
   */
  async verifyPush(authHeader?: string): Promise<boolean> {
    const audience = process.env.PLAY_RTDN_AUDIENCE;
    const email = process.env.PLAY_RTDN_SA_EMAIL;
    if (!audience || !email) {
      this.logger.error(
        'RTDN bị từ chối: chưa cấu hình PLAY_RTDN_AUDIENCE / PLAY_RTDN_SA_EMAIL',
      );
      return false;
    }
    const idToken = authHeader?.match(/^Bearer (.+)$/)?.[1];
    if (!idToken) return false;
    try {
      const ticket = await this.oidc.verifyIdToken({ idToken, audience });
      const p = ticket.getPayload();
      return !!p && p.email === email && p.email_verified === true;
    } catch {
      return false;
    }
  }

  /**
   * Xử lý một thông báo RTDN đã xác thực.
   *
   * Không tin nội dung thông báo ngoài cái token: loại thông báo chỉ là gợi ý
   * "có gì đó đổi", còn trạng thái thật luôn tra lại từ Google. Thông báo có
   * thể đến trễ, trùng, sai thứ tự — tra lại thì cả ba đều vô hại.
   *
   * Trả về `retry` khi lỗi tạm thời: lớp gọi trả 5xx để Pub/Sub gửi lại.
   */
  async handleNotification(
    body: any,
  ): Promise<{ ok: boolean; retry?: boolean; note: string }> {
    let msg: any;
    try {
      msg = JSON.parse(
        Buffer.from(String(body?.message?.data ?? ''), 'base64').toString(
          'utf8',
        ),
      );
    } catch {
      return { ok: true, note: 'bad-payload' };
    }
    if (msg?.packageName !== GooglePlayBillingService.packageName()) {
      return { ok: true, note: 'other-package' };
    }
    if (msg.testNotification) return { ok: true, note: 'test' };

    const voided = msg.voidedPurchaseNotification;
    if (voided?.purchaseToken) {
      // productType 1 = gói định kỳ. Mình chỉ bán gói định kỳ trên Play.
      const done = await this.revoke(
        voided.purchaseToken,
        'rtdn:voided',
        voided.orderId,
      );
      return { ok: true, note: done ? 'revoked' : 'voided-unknown-token' };
    }

    const token = msg.subscriptionNotification?.purchaseToken;
    if (!token) return { ok: true, note: 'ignored' };

    let data: PlaySubscriptionV2;
    try {
      data = await this.fetchSubscription(token);
    } catch (e) {
      if (e instanceof PlayReceiptRejected) {
        return { ok: true, note: `google-${e.status}` };
      }
      this.logger.error(`RTDN: không tra được biên lai: ${String(e)}`);
      return { ok: false, retry: true, note: 'unreachable' };
    }

    // Chủ biên lai: dòng đã có, hoặc tài khoản app gắn vào lúc mua
    // (`applicationUserName`) — trường hợp app chết ngay sau khi trả tiền và
    // RTDN về trước.
    const row = await this.prisma.subscription.findFirst({
      where: {
        provider: 'GOOGLE_PLAY',
        externalId: { in: [token, data.linkedPurchaseToken].filter(Boolean) as string[] },
      },
    });
    let userId = row?.userId;
    if (!userId) {
      const bound = data.externalAccountIdentifiers?.obfuscatedExternalAccountId;
      if (bound && /^[0-9a-f-]{36}$/i.test(bound)) {
        const user = await this.prisma.user.findUnique({
          where: { id: bound },
          select: { id: true },
        });
        userId = user?.id;
      }
    }
    if (!userId) return { ok: true, note: 'owner-unknown' };

    const result = await this.apply(userId, token, data, 'rtdn');
    if (
      result &&
      data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' &&
      GooglePlayBillingService.isUsable(data.subscriptionState)
    ) {
      await this.acknowledge(data.lineItems![0].productId!, token);
    }
    return { ok: true, note: result ? `synced:${result.status}` : 'no-change' };
  }

  // ───────────────────────────────────────────────────────────────────────

  private client(): GoogleAuth | null {
    if (this.auth !== undefined) return this.auth;
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) return (this.auth = null);
    try {
      this.auth = new GoogleAuth({
        credentials: JSON.parse(raw),
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
    } catch {
      this.logger.error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ');
      this.auth = null;
    }
    return this.auth;
  }
}
