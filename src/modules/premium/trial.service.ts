import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Plan, SubStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TrialEligibilityService,
  TrialSignals,
} from './trial-eligibility.service';
import { MONTHLY_PRICE, PaidPlan } from './pricing';

/** Độ dài một lần dùng thử. */
export const TRIAL_DAYS = 3;

/**
 * Gói được mở khoá trong thời gian dùng thử.
 *
 * Mở `PLUS` chứ không phải `SQUAD`: dùng thử là để người ta thấy sản phẩm đầy
 * đủ ở mức mình thật sự định bán cho họ. Cho nếm gói đắt nhất rồi hạ xuống gói
 * rẻ là tự tạo cảm giác mất mát ngay ở ngày đầu tiên trả tiền.
 */
export const TRIAL_PLAN: PaidPlan = 'PLUS';

@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    private prisma: PrismaService,
    private eligibility: TrialEligibilityService,
  ) {}

  /**
   * Tình trạng dùng thử của một người — client dựng banner và đồng hồ đếm
   * ngược từ đây.
   *
   * Trả về mốc thời gian tuyệt đối dạng ISO (UTC), **không** trả về "còn mấy
   * ngày". Client tự trừ theo giờ máy nó: gửi số ngày đi thì đồng hồ sẽ sai
   * ngay khi người dùng đổi múi giờ giữa chuyến bay — đúng cái việc mà app này
   * tồn tại để phục vụ.
   */
  async status(userId: string) {
    const claim = await this.prisma.trialClaim.findFirst({
      where: { userId },
      orderBy: { startedAt: 'desc' },
    });

    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'TRIALING' },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    const now = new Date();
    const active = !!sub && sub.currentPeriodEnd > now;

    return {
      /// Đang trong thời gian dùng thử.
      active,
      /// Mốc kết thúc, ISO UTC. `null` khi không có lần dùng thử nào đang chạy.
      endsAt: active ? sub.currentPeriodEnd.toISOString() : null,
      startedAt: claim?.startedAt?.toISOString() ?? null,
      plan: active ? sub.plan : null,
      /// Đã từng dùng thử — dùng để không mời lại người đã dùng rồi.
      hasTrialed: !!claim,
      outcome: claim?.outcome ?? null,
      /// Điều khoản, để màn mời hiện đúng thứ sẽ xảy ra sau khi hết hạn.
      terms: this.terms(),
    };
  }

  /**
   * Điều khoản dùng thử, nói đúng những gì thật sự xảy ra.
   *
   * `autoCharge: false` là sự thật của hệ thống này, không phải một lựa chọn
   * sản phẩm: cả Momo lẫn ZaloPay ở mức tích hợp hiện tại đều **không có cơ
   * chế trừ tiền định kỳ** — không có thẻ lưu, không có mandate. Không có gì
   * để tự động thu.
   *
   * Nên phần "sau 3 ngày tự động chuyển sang gói rẻ nhất và bị trừ tiền"
   * KHÔNG được hứa ở đây. Hứa một khoản thu không bao giờ xảy ra cũng là nói
   * dối người dùng, chỉ theo chiều ngược lại.
   */
  terms() {
    return {
      days: TRIAL_DAYS,
      plan: TRIAL_PLAN,
      /// Không tự động trừ tiền khi hết hạn.
      autoCharge: false,
      /// Hết hạn thì về đâu.
      revertsTo: 'FREE' as Plan,
      /// Giá nếu người dùng chủ động mua tiếp.
      priceAfter: MONTHLY_PRICE[TRIAL_PLAN],
      currency: 'VND',
    };
  }

  /**
   * Bắt đầu dùng thử.
   *
   * Cố ý **không** tự chạy lúc đăng ký. Đồng hồ ba ngày chỉ có ý nghĩa khi
   * người dùng biết nó đang chạy; bật lén từ lúc tạo tài khoản thì phần lớn
   * người dùng tiêu hết ba ngày trước khi kịp mở app lần thứ hai, và cái họ
   * nhận được không phải là một lần dùng thử mà là một thông báo hết hạn.
   *
   * Đổi lại, nơi gọi phải hiện điều khoản trước — xem `terms()`.
   */
  async start(userId: string, signals: TrialSignals) {
    const now = new Date();

    // Đang có gói (trả tiền hoặc đang thử) thì không có gì để bắt đầu.
    const existing = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
        currentPeriodEnd: { gt: now },
      },
    });
    if (existing) {
      throw new BadRequestException({
        code: 'ALREADY_SUBSCRIBED',
        message: 'errors.premium.alreadySubscribed',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const result = await this.eligibility.evaluate(userId, {
      ...signals,
      email: signals.email ?? user?.email ?? null,
    });

    if (result.verdict === 'INELIGIBLE') {
      // Vẫn ghi lại lần bị từ chối: không ghi thì không đo được tầng xét duyệt
      // có chặn oan hay không, và lần sau cũng không biết đã từ chối vì gì.
      await this.prisma.trialClaim.create({
        data: {
          userId,
          ...result.hashes,
          verdict: result.verdict,
          reasons: result.reasons,
          outcome: 'CANCELED',
          endedAt: now,
        },
      });
      await this.log(userId, 'TRIAL_DENIED', {
        actor: 'user',
        meta: { reasons: result.reasons },
      });
      throw new BadRequestException({
        code: 'TRIAL_NOT_ELIGIBLE',
        message: 'errors.premium.trialNotEligible',
        reasons: result.reasons,
      });
    }

    // `REVIEW` vẫn được dùng thử — chỉ khác ở chỗ được đánh dấu để soi lại.
    // Chặn khi mới chỉ nghi ngờ là đánh đổi sai: cái mất là người dùng thật,
    // cái được chỉ là ba ngày bản trả phí.
    const endsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const sub = await this.prisma.subscription.create({
      data: {
        userId,
        plan: TRIAL_PLAN,
        status: 'TRIALING',
        // `CASH` vì không có tiền nào đi qua cổng nào. Không bịa ra một
        // provider để trông cho giống một giao dịch thật.
        provider: 'CASH',
        currentPeriodStart: now,
        currentPeriodEnd: endsAt,
      },
    });

    await this.prisma.trialClaim.create({
      data: {
        userId,
        ...result.hashes,
        verdict: result.verdict,
        reasons: result.reasons,
        startedAt: now,
        endsAt,
        outcome: 'RUNNING',
      },
    });

    await this.log(userId, 'TRIAL_STARTED', {
      actor: 'user',
      toStatus: 'TRIALING',
      plan: TRIAL_PLAN,
      meta: { verdict: result.verdict, reasons: result.reasons },
    });

    return {
      active: true,
      endsAt: endsAt.toISOString(),
      startedAt: now.toISOString(),
      plan: sub.plan,
      terms: this.terms(),
    };
  }

  /**
   * Dừng dùng thử trước hạn.
   *
   * Ở đây "huỷ" nghĩa là **cắt ngay**, khác với huỷ gói đã trả tiền (giữ tới
   * hết kỳ). Vì không có khoản thu nào đang chờ, lý do duy nhất người ta bấm
   * nút này là muốn dừng — nên tôn trọng đúng nghĩa đó.
   *
   * Nút phải dễ tìm. Giấu nó đi chẳng giữ lại được ai, chỉ đổi một lần huỷ
   * thành một lần gỡ app.
   */
  async cancel(userId: string) {
    const now = new Date();
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'TRIALING', currentPeriodEnd: { gt: now } },
    });
    if (!sub) {
      throw new BadRequestException({
        code: 'NO_ACTIVE_TRIAL',
        message: 'errors.premium.noActiveTrial',
      });
    }

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'CANCELED',
        canceledAt: now,
        // Cắt hiệu lực ngay bằng cách kéo mốc hết hạn về hiện tại: mọi kiểm
        // tra quyền đều so với `currentPeriodEnd`, nên đổi mỗi `status` là
        // chưa đủ.
        currentPeriodEnd: now,
      },
    });

    await this.prisma.trialClaim.updateMany({
      where: { userId, outcome: 'RUNNING' },
      data: { outcome: 'CANCELED', endedAt: now },
    });

    await this.log(userId, 'TRIAL_CANCELED', {
      actor: 'user',
      fromStatus: 'TRIALING',
      toStatus: 'CANCELED',
    });

    return { active: false, endedAt: now.toISOString() };
  }

  /**
   * Đóng các lần dùng thử đã quá hạn.
   *
   * Quyền hạn thì đã tự hết đúng lúc — mọi kiểm tra đều so với
   * `currentPeriodEnd`, nên không có ai giữ được bản trả phí quá ba ngày kể cả
   * khi việc này không chạy. Việc này chỉ để **hàng trong bảng khớp với sự
   * thật**: không dọn thì mọi lần dùng thử đã hết vẫn mang `status: TRIALING`
   * vĩnh viễn, và mọi báo cáo đếm theo cột đó đều sai.
   *
   * Trả về số bản ghi đã đóng để nơi gọi ghi log được.
   */
  async expireDue(): Promise<number> {
    const now = new Date();

    const due = await this.prisma.subscription.findMany({
      where: { status: 'TRIALING', currentPeriodEnd: { lte: now } },
      select: { id: true, userId: true },
    });
    if (due.length === 0) return 0;

    await this.prisma.subscription.updateMany({
      where: { id: { in: due.map((d) => d.id) } },
      data: { status: 'EXPIRED' },
    });

    await this.prisma.trialClaim.updateMany({
      where: {
        userId: { in: due.map((d) => d.userId) },
        outcome: 'RUNNING',
      },
      data: { outcome: 'EXPIRED', endedAt: now },
    });

    await this.prisma.subscriptionEvent.createMany({
      data: due.map((d) => ({
        userId: d.userId,
        type: 'TRIAL_EXPIRED',
        fromStatus: 'TRIALING',
        toStatus: 'EXPIRED',
        actor: 'job:trial-expiry',
      })),
    });

    this.logger.log(`Đã đóng ${due.length} lần dùng thử hết hạn`);
    return due.length;
  }

  /**
   * Đánh dấu lần dùng thử đã chuyển thành gói trả tiền.
   *
   * Gọi từ luồng cấp quyền sau thanh toán: người mua trong lúc còn dùng thử là
   * tín hiệu quan trọng nhất để biết trial có tác dụng hay không, mà không ghi
   * lại thì không đo được.
   */
  async markConverted(userId: string) {
    const updated = await this.prisma.trialClaim.updateMany({
      where: { userId, outcome: 'RUNNING' },
      data: { outcome: 'CONVERTED', endedAt: new Date() },
    });
    if (updated.count > 0) {
      await this.log(userId, 'TRIAL_CONVERTED', {
        actor: 'webhook',
        fromStatus: 'TRIALING',
        toStatus: 'ACTIVE',
      });
    }
  }

  /**
   * Ghi một dòng nhật ký trạng thái gói.
   *
   * Chỉ ghi thêm, không sửa. Khi người dùng hỏi "sao tôi mất gói" thì đây là
   * thứ duy nhất trả lời được — log ứng dụng đã bị xoay vòng từ lâu.
   */
  async log(
    userId: string,
    type: string,
    opts: {
      actor: string;
      fromStatus?: string;
      toStatus?: string;
      plan?: Plan;
      meta?: Record<string, unknown>;
    },
  ) {
    await this.prisma.subscriptionEvent.create({
      data: {
        userId,
        type,
        actor: opts.actor,
        fromStatus: opts.fromStatus,
        toStatus: opts.toStatus,
        plan: opts.plan,
        meta: opts.meta as never,
      },
    });
  }
}
