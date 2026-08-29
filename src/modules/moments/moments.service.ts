import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateMomentDto } from './dto/create-moment.dto';

@Injectable()
export class MomentsService {
  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async create(tripId: string, userId: string, dto: CreateMomentDto) {
    const row = await this.prisma.moment.create({
      data: {
        tripId,
        userId,
        mediaUrl: dto.mediaUrl,
        type: dto.type ?? 'PHOTO',
        isGhost: dto.isGhost ?? false,
        caption: dto.caption,
        latitude: dto.latitude,
        longitude: dto.longitude,
        mediaId: dto.mediaId,
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { reactions: true, comments: true } },
      },
    });
    // Ghi nhật ký hoạt động để feed squad có dữ liệu — trước đây
    // ActivitiesService.log() không được gọi ở bất kỳ đâu.
    await this.activities.log(tripId, userId, 'MOMENT_SHARED', {
      caption: row.caption ?? '',
    });
    return row;
  }

  async findAll(tripId: string) {
    return this.prisma.moment.findMany({
      where: { tripId, deletedAt: null },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { reactions: true, comments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const moment = await this.prisma.moment.findUnique({
      where: { id, deletedAt: null },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        comments: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        reactions: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!moment) throw new NotFoundException('Moment not found');
    return moment;
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  /**
   * Sửa caption của khoảnh khắc — chỉ tác giả được sửa.
   *
   * Màn AI Memory Sorting trước đây có nút "Approve Sorting" chỉ lật một cờ
   * trong bộ nhớ rồi hiện snackbar; không có endpoint nào để lưu nên caption
   * AI gợi ý biến mất ngay khi thoát màn.
   */
  async updateCaption(id: string, userId: string, caption: string) {
    const moment = await this.prisma.moment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!moment) throw new NotFoundException('errors.database.notFound');
    if (moment.userId !== userId) {
      throw new ForbiddenException('errors.moments.notAuthor');
    }
    return this.prisma.moment.update({
      where: { id },
      data: { caption },
    });
  }

  /**
   * Xoá mềm khoảnh khắc.
   *
   * `userId` trước đây được nhận nhưng không dùng — nghĩa là bất kỳ thành viên
   * nào trong chuyến cũng xoá được ảnh của người khác. Nay chỉ tác giả, hoặc
   * người tạo chuyến (để kiểm duyệt), mới xoá được.
   */
  async delete(id: string, userId: string) {
    const moment = await this.prisma.moment.findUnique({ where: { id } });
    if (!moment) throw new NotFoundException('errors.database.notFound');

    if (moment.userId !== userId) {
      const membership = await this.prisma.tripMember.findFirst({
        where: { tripId: moment.tripId, userId, role: 'CREATOR' },
      });
      if (!membership) {
        throw new ForbiddenException('errors.moments.cannotDelete');
      }
    }

    return this.prisma.moment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addComment(momentId: string, userId: string, content: string) {
    return this.prisma.momentComment.create({
      data: { momentId, userId, content },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async toggleReaction(momentId: string, userId: string, emoji: string) {
    const existing = await this.prisma.momentReaction.findUnique({
      where: { momentId_userId_emoji: { momentId, userId, emoji } },
    });
    if (existing) {
      await this.prisma.momentReaction.delete({
        where: { momentId_userId_emoji: { momentId, userId, emoji } },
      });
      return { action: 'removed', emoji };
    }
    await this.prisma.momentReaction.create({
      data: { momentId, userId, emoji },
    });
    return { action: 'added', emoji };
  }
}
