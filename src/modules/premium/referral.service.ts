import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { XpService } from '../xp/xp.service';

/**
 * XP trao cho mỗi bên khi một lần giới thiệu thành công.
 *
 * Đọc từ `EARN_RULES` của XpService thay vì ghi lại số ở đây: chép số ra hai
 * chỗ là kiểu lỗi vừa xảy ra một lần trong chính file đó — hai định nghĩa
 * `REFERRAL_SENT` cùng tồn tại, bản sau âm thầm ghi đè bản trước, và không có
 * gì báo.
 */
export const REFERRER_XP = XpService.amountFor('REFERRAL_SENT');
export const REFEREE_XP = XpService.amountFor('REFERRAL_RECEIVED');

/**
 * Bảng chữ cái của mã giới thiệu.
 *
 * Bỏ `0/O`, `1/I/L`: mã này tồn tại để người ta **đọc cho nhau qua điện thoại**
 * và gõ lại. Một ký tự nhìn nhầm là một lần nhập sai, và người nhập sai hai
 * lần thì bỏ cuộc.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private prisma: PrismaService,
    private xp: XpService,
  ) {}

  /**
   * Mã giới thiệu của tôi, sinh lần đầu được hỏi tới.
   *
   * Sinh lười thay vì sinh cho mọi người lúc đăng ký: phần lớn người dùng
   * không bao giờ mở màn này, và một bảng đầy mã chưa ai dùng chỉ làm chậm mọi
   * truy vấn tra ngược.
   */
  async myCode(userId: string) {
    const existing = await this.prisma.referralCode.findUnique({
      where: { userId },
    });
    if (existing) return this.withStats(existing.code, userId);

    // Va mã là chuyện có thật với 31^6 khả năng khi lượng người dùng lớn, nên
    // thử lại thay vì tin vào may mắn. Bắt lỗi unique thay vì kiểm tra trước:
    // kiểm tra rồi mới ghi vẫn có khe hở giữa hai bước.
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.generateCode();
      try {
        await this.prisma.referralCode.create({ data: { userId, code } });
        return this.withStats(code, userId);
      } catch {
        // Trùng mã hoặc người này vừa được cấp mã ở một request song song.
        const now = await this.prisma.referralCode.findUnique({
          where: { userId },
        });
        if (now) return this.withStats(now.code, userId);
      }
    }
    throw new BadRequestException({
      code: 'CODE_GENERATION_FAILED',
      message: 'errors.referral.generationFailed',
    });
  }

  private generateCode(): string {
    let out = '';
    for (let i = 0; i < 6; i++) {
      // `randomInt` thay cho `Math.random`: mã đoán được nghĩa là đoán được
      // mã của người khác rồi tự nhập cho mình.
      out += ALPHABET[randomInt(ALPHABET.length)];
    }
    return out;
  }

  /** Mã kèm số liệu thật, đọc từ bảng. */
  private async withStats(code: string, userId: string) {
    const referrals = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        referee: { select: { name: true, username: true, avatarUrl: true } },
      },
    });

    const totalXp = referrals.reduce((sum, r) => sum + r.referrerXp, 0);

    return {
      code,
      /// Số bạn đã mời thành công. Trước đây màn này hiện một con số cứng.
      count: referrals.length,
      totalXp,
      rewardPerInvite: REFERRER_XP,
      /// Danh sách người thật, không phải tên bịa.
      invited: referrals.map((r) => ({
        name: r.referee.name,
        username: r.referee.username,
        avatarUrl: r.referee.avatarUrl,
        joinedAt: r.createdAt,
        xp: r.referrerXp,
      })),
    };
  }

  /**
   * Nhập mã của người khác.
   *
   * Trước đây hàm này trả `success: true` cho **mọi** chuỗi, tặng 500 XP trên
   * giấy mà không ghi vào đâu, và chỉ chặn đúng một chuỗi literal `'SELF'` —
   * nên "không tự giới thiệu mình" thực tế không được kiểm.
   */
  async submit(userId: string, rawCode: string) {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) {
      throw new BadRequestException({
        code: 'CODE_REQUIRED',
        message: 'errors.referral.codeRequired',
      });
    }

    const owner = await this.prisma.referralCode.findUnique({
      where: { code },
      select: { userId: true },
    });
    if (!owner) {
      throw new NotFoundException({
        code: 'CODE_NOT_FOUND',
        message: 'errors.referral.notFound',
      });
    }

    // Tự giới thiệu mình: so theo **chủ sở hữu mã**, không theo chuỗi. Đây là
    // cách kiểm duy nhất đúng — chuỗi thì ai cũng đổi được.
    if (owner.userId === userId) {
      throw new BadRequestException({
        code: 'SELF_REFERRAL',
        message: 'errors.referral.self',
      });
    }

    // Mỗi người chỉ được giới thiệu một lần trong đời. Ràng buộc thật nằm ở
    // `@unique` trên `refereeId`; kiểm ở đây chỉ để trả lỗi cho tử tế.
    const already = await this.prisma.referral.findUnique({
      where: { refereeId: userId },
    });
    if (already) {
      throw new BadRequestException({
        code: 'ALREADY_REFERRED',
        message: 'errors.referral.alreadyReferred',
      });
    }

    // Vòng giới thiệu qua lại: A mời B rồi B mời lại A là hai lần thưởng cho
    // đúng không người dùng mới nào.
    const reciprocal = await this.prisma.referral.findFirst({
      where: { referrerId: userId, refereeId: owner.userId },
    });
    if (reciprocal) {
      throw new BadRequestException({
        code: 'RECIPROCAL_REFERRAL',
        message: 'errors.referral.reciprocal',
      });
    }

    try {
      await this.prisma.referral.create({
        data: {
          referrerId: owner.userId,
          refereeId: userId,
          code,
          referrerXp: REFERRER_XP,
          refereeXp: REFEREE_XP,
        },
      });
    } catch {
      // Hai request song song: `@unique` giữ lại đúng một bản ghi.
      throw new BadRequestException({
        code: 'ALREADY_REFERRED',
        message: 'errors.referral.alreadyReferred',
      });
    }

    // Trao XP THẬT qua sổ cái XP, không phải một con số trong response.
    // `refId` là id người kia nên `unique(userId, reason, refId)` chặn luôn
    // việc cộng trùng nếu chỗ này bị gọi lại.
    const [refereeAward] = await Promise.all([
      this.xp.award(userId, 'REFERRAL_RECEIVED', {
        refId: owner.userId,
        amount: REFEREE_XP,
      }),
      this.xp.award(owner.userId, 'REFERRAL_SENT', {
        refId: userId,
        amount: REFERRER_XP,
      }),
    ]);

    this.logger.log(`Giới thiệu: ${owner.userId} → ${userId} (mã ${code})`);

    return {
      success: true,
      code,
      /// XP người NHẬP mã được nhận. Người mời nhận `REFERRER_XP`, xem ở màn
      /// mã của họ.
      rewardXp: REFEREE_XP,
      balance: refereeAward.balance,
    };
  }

  /**
   * Trạng thái giới thiệu của tôi: đã nhập mã ai chưa.
   *
   * Client cần biết để ẩn ô nhập mã thay vì để người dùng gõ vào rồi nhận lỗi.
   */
  async status(userId: string) {
    const received = await this.prisma.referral.findUnique({
      where: { refereeId: userId },
      include: { referrer: { select: { name: true, username: true } } },
    });
    return {
      canSubmit: !received,
      referredBy: received
        ? {
            name: received.referrer.name,
            username: received.referrer.username,
            at: received.createdAt,
            xp: received.refereeXp,
          }
        : null,
    };
  }
}
