import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import {
  CreateMomentDto,
  UpdateMomentLayoutDto,
} from './dto/create-moment.dto';
import { EntitlementService } from '../premium/entitlement.service';
import { ghostRevealAt, isDeveloping, visibleMomentWhere } from './ghost';

interface CachedBoardSnapshot {
  expiresAt: number;
  endDateIso: string | null;
  rows: any[];
}

@Injectable()
export class MomentsService {
  private static readonly BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly l1BoardCache = new Map<string, CachedBoardSnapshot>();

  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly entitlements: EntitlementService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) {}

  private boardCacheKey(tripId: string): string {
    return `board:trip:${tripId}:v1`;
  }

  /**
   * Xoá cache bảng kỷ niệm dùng chung của chuyến đi ngay khi có thay đổi
   * (thêm ảnh, kéo đổi tọa độ, đổi filter, thả tim, bình luận, xoá).
   */
  async invalidateBoardCache(tripId?: string | null): Promise<void> {
    if (!tripId) return;
    this.l1BoardCache.delete(tripId);
    try {
      await this.cache?.del(this.boardCacheKey(tripId));
    } catch {
      // Bỏ qua lỗi Redis để không làm gián đoạn luồng chính.
    }
  }

  /**
   * Tính vị trí & góc nghiêng mặc định trên bảng kỷ niệm (Shared Memory Photo Board)
   * theo hành trình dọc từ trên xuống dưới (Vertical Winding Journey Trail).
   */
  private defaultBoardPlacement(index: number) {
    const waypointsX = [76, 332, 118, 308];
    const wp = index % waypointsX.length;
    const jitterX = ((index * 37) % 36) - 18;
    const jitterY = ((index * 53) % 28) - 14;
    const rotation = Number(((((index * 19) % 15) - 7) * 0.012).toFixed(3));
    return {
      boardX: waypointsX[wp] + jitterX,
      boardY: 128 + index * 246 + jitterY,
      boardRotation: rotation === 0 ? (index % 2 === 0 ? -0.035 : 0.035) : rotation,
    };
  }

  async create(tripId: string, userId: string, dto: CreateMomentDto) {
    const moments = await this.prisma.moment.count({
      where: { tripId, deletedAt: null },
    });
    await this.entitlements.assertTripWithin(
      tripId,
      'momentsPerTrip',
      moments,
    );

    const placement = this.defaultBoardPlacement(moments);

    // mediaId phải là file của CHÍNH người tạo — không thì gắn được file của
    // người khác vào khoảnh khắc của mình bằng cách đoán id.
    if (dto.mediaId) {
      const owned = await this.prisma.media.findFirst({
        where: { id: dto.mediaId, userId },
        select: { id: true },
      });
      if (!owned) throw new ForbiddenException('errors.storage.mediaNotOwned');
    }

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
        boardX: dto.boardX ?? placement.boardX,
        boardY: dto.boardY ?? placement.boardY,
        boardRotation: dto.boardRotation ?? placement.boardRotation,
        boardScale: dto.boardScale ?? 1.0,
        boardFilter: dto.boardFilter ?? 'CLASSIC',
        noteColor: dto.noteColor,
        isPinned: dto.isPinned ?? false,
        isFavorite: dto.isFavorite ?? false,
        takenAt: dto.takenAt ? new Date(dto.takenAt) : undefined,
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { reactions: true, comments: true } },
      },
    });
    await this.invalidateBoardCache(tripId);
    await this.activities.log(
      tripId,
      userId,
      'MOMENT_SHARED',
      { caption: row.isGhost ? '' : (row.caption ?? '') },
      row.id,
    );
    return row;
  }

  /**
   * Lấy toàn bộ ảnh trên bảng kỷ niệm của chuyến đi.
   * Sử dụng Shared Trip Board Cache (Redis + L1 RAM) để khi thành viên đầu tiên
   * mở bảng, các thành viên tiếp theo trong nhóm nhận ngay snapshot đã dựng sẵn
   * trong < 2ms mà không phải query lại PostgreSQL.
   */
  async findAll(tripId: string, viewerId: string) {
    const now = Date.now();
    let snapshot: CachedBoardSnapshot | undefined = this.l1BoardCache.get(tripId);
    if (snapshot && snapshot.expiresAt <= now) {
      this.l1BoardCache.delete(tripId);
      snapshot = undefined;
    }

    if (!snapshot && this.cache) {
      try {
        const cached = await this.cache.get<CachedBoardSnapshot>(
          this.boardCacheKey(tripId),
        );
        if (cached && cached.expiresAt > now) {
          snapshot = cached;
          this.l1BoardCache.set(tripId, cached);
        }
      } catch {
        // Fallback to DB query if Redis is unavailable
      }
    }

    if (!snapshot) {
      const [trip, rows] = await Promise.all([
        this.prisma.trip.findUnique({
          where: { id: tripId },
          select: { endDate: true },
        }),
        this.prisma.moment.findMany({
          where: { tripId, deletedAt: null },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
            reactions: true,
            _count: { select: { reactions: true, comments: true } },
          },
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
          take: 500,
        }),
      ]);

      snapshot = {
        expiresAt: now + MomentsService.BOARD_CACHE_TTL_MS,
        endDateIso: trip?.endDate ? new Date(trip.endDate).toISOString() : null,
        rows,
      };
      this.l1BoardCache.set(tripId, snapshot);
      try {
        await this.cache?.set(
          this.boardCacheKey(tripId),
          snapshot,
          MomentsService.BOARD_CACHE_TTL_MS,
        );
      } catch {
        // Ignore cache write errors
      }
    }

    const endDate = snapshot.endDateIso ? new Date(snapshot.endDateIso) : null;
    // Lọc người viewer đã chặn SAU khi đọc cache: snapshot dùng chung theo
    // chuyến, không được trộn dữ liệu riêng của từng người vào key chung.
    const blocked = new Set(
      (
        await this.prisma.userBlock.findMany({
          where: { blockerId: viewerId },
          select: { blockedId: true },
        })
      ).map((r) => r.blockedId),
    );
    return snapshot.rows
      .filter((m) => !blocked.has(m.userId))
      .filter((m) => {
        if (!m.isGhost || m.userId === viewerId) return true;
        if (!endDate) return true;
        return ghostRevealAt(endDate).getTime() <= now;
      })
      .map((m) =>
        endDate && isDeveloping(m, endDate)
          ? { ...m, developing: true, revealAt: ghostRevealAt(endDate) }
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

  /**
   * Cập nhật bố cục Polaroid trên Shared Memory Photo Board.
   * Mọi thành viên trong chuyến đi đều có thể sắp xếp vị trí/ghim/bộ lọc trên bảng chung;
   * riêng `caption` chỉ tác giả hoặc chủ chuyến mới được sửa.
   */
  async updateLayout(
    tripId: string,
    id: string,
    userId: string,
    dto: UpdateMomentLayoutDto,
  ) {
    await this.assertVisible(id, userId);
    const moment = await this.prisma.moment.findFirst({
      where: { id, tripId, deletedAt: null },
    });
    if (!moment) throw new NotFoundException('errors.database.notFound');

    const data: Record<string, unknown> = {};
    if (dto.boardX !== undefined) data.boardX = dto.boardX;
    if (dto.boardY !== undefined) data.boardY = dto.boardY;
    if (dto.boardRotation !== undefined) data.boardRotation = dto.boardRotation;
    if (dto.boardScale !== undefined) data.boardScale = dto.boardScale;
    if (dto.boardFilter !== undefined) data.boardFilter = dto.boardFilter;
    if (dto.noteColor !== undefined) data.noteColor = dto.noteColor;
    if (dto.isPinned !== undefined) data.isPinned = dto.isPinned;
    if (dto.isFavorite !== undefined) data.isFavorite = dto.isFavorite;
    if (dto.caption !== undefined) {
      if (moment.userId !== userId) {
        const isCreator = await this.prisma.tripMember.findFirst({
          where: { tripId, userId, role: 'CREATOR' },
        });
        if (!isCreator) {
          throw new ForbiddenException('errors.moments.notAuthor');
        }
      }
      data.caption = dto.caption;
    }

    const updated = await this.prisma.moment.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { reactions: true, comments: true } },
      },
    });
    await this.invalidateBoardCache(tripId);
    return updated;
  }

  /**
   * Đánh dấu / bỏ đánh dấu kỷ niệm nổi bật (Favorite / Highlight) trên bảng chung.
   */
  async toggleFavorite(tripId: string, id: string, userId: string) {
    await this.assertVisible(id, userId);
    const moment = await this.prisma.moment.findFirst({
      where: { id, tripId, deletedAt: null },
    });
    if (!moment) throw new NotFoundException('errors.database.notFound');

    const updated = await this.prisma.moment.update({
      where: { id },
      data: { isFavorite: !moment.isFavorite },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { reactions: true, comments: true } },
      },
    });
    await this.invalidateBoardCache(tripId);
    return updated;
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
    const updated = await this.prisma.moment.update({
      where: { id },
      data: { caption },
    });
    await this.invalidateBoardCache(moment.tripId);
    return updated;
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

    const deleted = await this.prisma.moment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.invalidateBoardCache(moment.tripId);
    return deleted;
  }

  async addComment(momentId: string, userId: string, content: string) {
    await this.assertVisible(momentId, userId);
    const created = await this.prisma.momentComment.create({
      data: { momentId, userId, content },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    const moment = await this.prisma.moment.findUnique({
      where: { id: momentId },
      select: { tripId: true },
    });
    if (moment?.tripId) {
      await this.invalidateBoardCache(moment.tripId);
    }
    return created;
  }

  async toggleReaction(momentId: string, userId: string, emoji: string) {
    await this.assertVisible(momentId, userId);
    const existing = await this.prisma.momentReaction.findUnique({
      where: { momentId_userId_emoji: { momentId, userId, emoji } },
    });
    const moment = await this.prisma.moment.findUnique({
      where: { id: momentId },
      select: { tripId: true },
    });
    if (existing) {
      await this.prisma.momentReaction.delete({
        where: { momentId_userId_emoji: { momentId, userId, emoji } },
      });
      if (moment?.tripId) {
        await this.invalidateBoardCache(moment.tripId);
      }
      return { action: 'removed', emoji };
    }
    await this.prisma.momentReaction.create({
      data: { momentId, userId, emoji },
    });
    if (moment?.tripId) {
      await this.invalidateBoardCache(moment.tripId);
    }
    return { action: 'added', emoji };
  }
}
