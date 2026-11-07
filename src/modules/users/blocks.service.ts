import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Chặn người dùng. App đã có nút "Chặn" ở hồ sơ công khai và trong chat từ
 * lâu nhưng gọi `POST /users/me/blocks` — route chưa từng tồn tại, nên app
 * báo "Đã chặn" mà thực ra không có gì xảy ra.
 */
@Injectable()
export class BlocksService {
  constructor(private readonly prisma: PrismaService) {}

  async block(blockerId: string, blockedId: string) {
    if (!blockedId || blockedId === blockerId) {
      throw new BadRequestException('Không thể tự chặn chính mình');
    }
    const target = await this.prisma.user.findFirst({
      where: { id: blockedId, deletedAt: null },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Không tìm thấy người dùng');
    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });
    return { blocked: true, blockedId };
  }

  async unblock(blockerId: string, blockedId: string) {
    await this.prisma.userBlock.deleteMany({ where: { blockerId, blockedId } });
    return { blocked: false, blockedId };
  }

  async list(blockerId: string) {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        blocked: {
          select: { id: true, name: true, username: true, avatarUrl: true },
        },
      },
    });
    return rows.map((r) => ({ ...r.blocked, blockedAt: r.createdAt }));
  }

  /** Id những người [userId] đã chặn — dùng để lọc chat/khoảnh khắc. */
  async blockedIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    return rows.map((r) => r.blockedId);
  }
}
