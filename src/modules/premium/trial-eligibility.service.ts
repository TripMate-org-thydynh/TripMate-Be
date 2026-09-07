import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { TrialVerdict } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Tín hiệu thô do lớp gọi thu thập từ request. Không cái nào bắt buộc. */
export interface TrialSignals {
  /** Email đăng ký. Dùng để phát hiện các biến thể của cùng một hộp thư. */
  email?: string | null;
  /** Mã thiết bị do client sinh và giữ lại. Client bịa được, nên chỉ là một tín hiệu. */
  deviceId?: string | null;
  /** IP của request. Được rút về dải /24 rồi băm — không lưu IP đầy đủ. */
  ip?: string | null;
}

export interface EligibilityResult {
  verdict: TrialVerdict;
  /** Mã lý do máy đọc được, để dựng báo cáo và để người trực hiểu vì sao. */
  reasons: string[];
  /** Các băm đã tính, để lưu cùng lần xin dùng thử. */
  hashes: {
    emailHash: string;
    deviceHash: string | null;
    networkHash: string | null;
  };
}

/**
 * Quyết định một người có được dùng thử hay không.
 *
 * Bài toán không phải là "chặn cho bằng được". Trước đây hệ thống không có gì
 * cả nên câu hỏi chưa từng được đặt ra; giờ có ba cách sai:
 *
 *   - Chỉ xét `userId`/email: tạo tài khoản mới là có trial mới, vô nghĩa.
 *   - Xét IP như một người: một ký túc xá, một quán cà phê, một nhà mạng di
 *     động NAT hàng nghìn người sau một địa chỉ — chặn theo IP là chặn oan
 *     hàng loạt người thật.
 *   - Ép mọi trường hợp về có/không: các tín hiệu đều là xác suất, nên phải có
 *     chỗ cho "chưa chắc".
 *
 * Nên: nhiều tín hiệu độc lập, mỗi tín hiệu một trọng số, và ba kết luận
 * (`ELIGIBLE` / `REVIEW` / `INELIGIBLE`). `REVIEW` **vẫn được dùng thử** — chỉ
 * là được đánh dấu để soi lại. Nghi ngờ mà chặn thẳng thì cái mất là người
 * dùng thật, còn cái được chỉ là ba ngày bản trả phí.
 *
 * Chỉ lưu băm có salt: câu hỏi cần trả lời là "cái này đã gặp chưa", và băm
 * trả lời đủ mà không giữ lại thứ có thể lần ra một con người.
 */
@Injectable()
export class TrialEligibilityService {
  private readonly logger = new Logger(TrialEligibilityService.name);

  /** Ngưỡng điểm để chuyển kết luận. */
  private static readonly REVIEW_AT = 2;
  private static readonly BLOCK_AT = 4;

  constructor(private prisma: PrismaService) {}

  async evaluate(
    userId: string,
    signals: TrialSignals,
  ): Promise<EligibilityResult> {
    const hashes = this.hashesOf(signals);
    const reasons: string[] = [];
    let score = 0;

    // ── Tín hiệu chắc chắn: chính tài khoản này đã dùng thử ────────────────
    const own = await this.prisma.trialClaim.findFirst({
      where: { userId, verdict: { not: 'INELIGIBLE' } },
    });
    if (own) {
      // Không cần cộng điểm hay xét gì thêm: đây là bằng chứng, không phải
      // suy đoán.
      return {
        verdict: 'INELIGIBLE',
        reasons: ['ALREADY_TRIALED'],
        hashes,
      };
    }

    // Đã từng trả tiền thì không phải đối tượng dùng thử nữa.
    const paid = await this.prisma.paymentOrder.findFirst({
      where: { userId, status: 'SUCCESS' },
    });
    if (paid) {
      return { verdict: 'INELIGIBLE', reasons: ['ALREADY_PAID'], hashes };
    }

    // ── Tín hiệu mạnh: cùng hộp thư đã dùng thử ────────────────────────────
    // Chuẩn hoá email bắt được `a.b+khuyenmai@gmail.com` và `ab@gmail.com`.
    const sameEmail = await this.prisma.trialClaim.findFirst({
      where: { emailHash: hashes.emailHash, userId: { not: userId } },
    });
    if (sameEmail) {
      score += 4;
      reasons.push('EMAIL_ALREADY_TRIALED');
    }

    // ── Tín hiệu mạnh: cùng thiết bị đã dùng thử ───────────────────────────
    if (hashes.deviceHash) {
      const sameDevice = await this.prisma.trialClaim.count({
        where: { deviceHash: hashes.deviceHash, userId: { not: userId } },
      });
      if (sameDevice >= 2) {
        // Từ hai lần trở lên trên cùng một máy là mẫu tạo tài khoản hàng loạt.
        score += 4;
        reasons.push('DEVICE_MULTIPLE_TRIALS');
      } else if (sameDevice === 1) {
        // Một lần thì rất có thể là máy dùng chung trong nhà, hoặc người dùng
        // lập tài khoản mới sau khi quên mật khẩu. Đủ để soi, chưa đủ để chặn.
        score += 2;
        reasons.push('DEVICE_SEEN_BEFORE');
      }
    } else {
      // Thiếu tín hiệu không phải là dấu hiệu xấu — client cũ, hoặc người dùng
      // từ chối cấp. Ghi lại để đọc báo cáo còn hiểu, không cộng điểm.
      reasons.push('NO_DEVICE_SIGNAL');
    }

    // ── Tín hiệu yếu: cùng dải mạng ────────────────────────────────────────
    // **Một mình không bao giờ đủ để chặn.** Trọng số cố tình thấp hơn ngưỡng
    // REVIEW, nên nó chỉ đẩy được kết luận khi đi kèm một tín hiệu khác.
    if (hashes.networkHash) {
      const sameNetwork = await this.prisma.trialClaim.count({
        where: {
          networkHash: hashes.networkHash,
          userId: { not: userId },
          startedAt: { gte: this.daysAgo(1) },
        },
      });
      if (sameNetwork >= 5) {
        score += 1;
        reasons.push('NETWORK_BURST');
      }
    }

    // ── Mẫu tạo tài khoản đáng ngờ ─────────────────────────────────────────
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, email: true },
    });
    if (user) {
      // Tài khoản vừa tạo xong đã xin dùng thử là hành vi hoàn toàn bình
      // thường của người dùng thật — KHÔNG tính điểm cho việc đó. Chỉ tính khi
      // đi kèm một tín hiệu khác, và điều đó đã được cộng ở trên rồi.
      //
      // Cái đáng chú ý là email dùng-một-lần: nó không phải hộp thư của ai cả,
      // nên "cùng email" không bao giờ bắt được người dùng lại.
      if (this.isDisposableEmail(user.email)) {
        score += 3;
        reasons.push('DISPOSABLE_EMAIL');
      }
    }

    const verdict: TrialVerdict =
      score >= TrialEligibilityService.BLOCK_AT
        ? 'INELIGIBLE'
        : score >= TrialEligibilityService.REVIEW_AT
          ? 'REVIEW'
          : 'ELIGIBLE';

    if (verdict !== 'ELIGIBLE') {
      this.logger.log(
        `Xét dùng thử ${userId}: ${verdict} (điểm ${score}) — ${reasons.join(', ')}`,
      );
    }

    return { verdict, reasons, hashes };
  }

  /**
   * Băm có salt cho từng tín hiệu.
   *
   * Salt riêng cho mỗi loại tín hiệu để không đối chiếu chéo được giữa các
   * bảng, và để một bản dump bảng này không cho phép thử ngược danh sách email
   * hay dải IP — không gian đầu vào của cả hai đều nhỏ, băm trần là dò ra
   * được trong vài phút.
   */
  private hash(kind: string, value: string): string {
    const salt = process.env.TRIAL_SIGNAL_SALT;
    if (!salt) {
      // Không có salt thì băm gần như vô nghĩa. Ghi cảnh báo thay vì âm thầm
      // chạy tiếp với một bí mật rỗng.
      this.logger.warn(
        'Thiếu TRIAL_SIGNAL_SALT — tín hiệu chống lạm dụng đang băm bằng salt mặc định',
      );
    }
    return createHmac('sha256', `${salt ?? 'tripmate-dev'}:${kind}`)
      .update(value.toLowerCase())
      .digest('hex');
  }

  private hashesOf(signals: TrialSignals) {
    return {
      emailHash: this.hash('email', this.normalizeEmail(signals.email ?? '')),
      deviceHash: signals.deviceId
        ? this.hash('device', signals.deviceId)
        : null,
      networkHash: this.networkOf(signals.ip)
        ? this.hash('network', this.networkOf(signals.ip) as string)
        : null,
    };
  }

  /**
   * Chuẩn hoá email về "hộp thư thật".
   *
   * Gmail bỏ qua dấu chấm và mọi thứ sau dấu `+`, nên `a.b+1@gmail.com` và
   * `ab@gmail.com` là cùng một người. Không chuẩn hoá thì tín hiệu email bắt
   * được đúng số không trường hợp.
   */
  normalizeEmail(raw: string): string {
    const email = raw.trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 0) return email;
    let local = email.slice(0, at);
    const domain = email.slice(at + 1);

    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      local = local.replace(/\./g, '');
      return `${local}@gmail.com`;
    }
    return `${local}@${domain}`;
  }

  /**
   * Rút IP về dải /24 (IPv4) hoặc /48 (IPv6).
   *
   * Giữ IP đầy đủ là giữ một thứ định danh được con người mà mình không cần.
   * Dải mạng đủ để thấy "một chùm tài khoản từ cùng một chỗ", mà không chỉ
   * được vào một máy cụ thể.
   */
  private networkOf(ip?: string | null): string | null {
    if (!ip) return null;
    const clean = ip.replace(/^::ffff:/, '').trim();
    if (clean.includes('.')) {
      const parts = clean.split('.');
      if (parts.length !== 4) return null;
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    if (clean.includes(':')) {
      const parts = clean.split(':');
      if (parts.length < 3) return null;
      return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
    }
    return null;
  }

  /**
   * Tên miền email dùng-một-lần.
   *
   * Danh sách ngắn và cố tình không đầy đủ: nó là một tín hiệu góp điểm, không
   * phải bộ lọc. Một danh sách dài luôn lỗi thời và luôn chặn oan vài tên miền
   * thật.
   */
  private isDisposableEmail(email: string): boolean {
    const domain = email.split('@')[1] ?? '';
    return [
      'mailinator.com',
      'guerrillamail.com',
      '10minutemail.com',
      'tempmail.com',
      'temp-mail.org',
      'yopmail.com',
      'throwawaymail.com',
      'trashmail.com',
      'sharklasers.com',
      'getnada.com',
    ].includes(domain);
  }

  private daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }
}
