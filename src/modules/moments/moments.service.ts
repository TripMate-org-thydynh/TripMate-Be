import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateMomentDto } from './dto/create-moment.dto';
import { EntitlementService } from '../premium/entitlement.service';
import { ghostRevealAt, isDeveloping, visibleMomentWhere } from './ghost';

@Injectable()
export class MomentsService {
  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly entitlements: EntitlementService,
  ) {}

  async create(tripId: string, userId: string, dto: CreateMomentDto) {
    // Hạn mức khoảnh khắc mỗi chuyến.
    //
    // Đếm cả moment của mọi thành viên, vì `momentsPerTrip` là giới hạn của
    // chuyến — chi phí lưu trữ nằm ở chuyến, không ở người đăng. Ảnh đã xoá
    // không tính: trước đây xoá bớt cũng không đăng thêm được, người dùng
    // không có cách nào tự gỡ khỏi trạng thái "đầy".
    const moments = await this.prisma.moment.count({
      where: { tripId, deletedAt: null },
    });
    await this.entitlements.assertTripWithin(
      tripId,
      'momentsPerTrip',
      moments,
    );

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
    await this.activities.log(
      tripId,
      userId,
      'MOMENT_SHARED',
      // Ảnh ghost: không lộ caption trước khi tráng.
      { caption: row.isGhost ? '' : (row.caption ?? '') },
      row.id,
    );
    return row;
  }

  async findAll(tripId: string, viewerId: string) {
    const [trip, rows] = await Promise.all([
      this.prisma.trip.findUnique({
        where: { id: tripId },
        select: { endDate: true },
      }),
      this.prisma.moment.findMany({
        where: { tripId, deletedAt: null, ...visibleMomentWhere(viewerId) },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
          reactions: true,
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        // Chặn trên an toàn: gói trả phí cho tới 1000 khoảnh khắc/chuyến, mà
        // app vẽ cả danh sách một lần. Nên chuyển sang phân trang con trỏ.
        take: 500,
      }),
    ]);
    // Ảnh ghost của chính mình vẫn thấy, kèm cờ để app vẽ nhãn "đang tráng".
    return rows.map((m) =>
      trip && isDeveloping(m, trip.endDate)
        ? { ...m, developing: true, revealAt: ghostRevealAt(trip.endDate) }
        : m,
    );
  }

  /**
   * Số ảnh ghost đang tráng trong chuyến. Thành viên khác chỉ biết con số,
   * không thấy ảnh — đủ để tò mò mà không lộ nội dung.
   */
  async developing(tripId: string, viewerId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { endDate: true },
    });
    if (!trip) throw new NotFoundException('errors.database.notFound');
    const revealAt = ghostRevealAt(trip.endDate);
    if (revealAt.getTime() <= Date.now()) {
      return { total: 0, mine: 0, revealAt, revealed: true };
    }
    const [total, mine] = await Promise.all([
      this.prisma.moment.count({
        where: { tripId, deletedAt: null, isGhost: true },
      }),
      this.prisma.moment.count({
        where: { tripId, deletedAt: null, isGhost: true, userId: viewerId },
      }),
    ]);
    return { total, mine, revealAt, revealed: false };
  }

  /** 404 nếu người xem chưa được thấy ảnh này (ghost chưa tráng). */
  private async assertVisible(id: string, viewerId: string) {
    const ok = await this.prisma.moment.count({
      where: { id, deletedAt: null, ...visibleMomentWhere(viewerId) },
    });
    if (!ok) throw new NotFoundException('Moment not found');
  }

  async findOne(id: string, viewerId: string) {
    await this.assertVisible(id, viewerId);
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
    await this.assertVisible(momentId, userId);
    return this.prisma.momentComment.create({
      data: { momentId, userId, content },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async toggleReaction(momentId: string, userId: string, emoji: string) {
    await this.assertVisible(momentId, userId);
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
