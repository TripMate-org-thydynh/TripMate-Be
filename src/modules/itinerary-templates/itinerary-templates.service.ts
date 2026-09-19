import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import {
  DuplicateTemplateDto,
  ListTemplatesQuery,
  PublishTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';

const AUTHOR_SELECT = {
  select: { id: true, name: true, username: true, avatarUrl: true },
} as const;

@Injectable()
export class ItineraryTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Chụp lịch trình hiện tại của chuyến thành một mẫu.
   *
   * Người gọi đã qua TripMemberGuard. Mẫu thuộc về NGƯỜI ĐĂNG, không phải chuyến:
   * chuyến bị xoá thì mẫu vẫn còn (sourceTripId về null).
   */
  async publish(tripId: string, userId: string, dto: PublishTemplateDto) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId, deletedAt: null },
      include: {
        itineraries: { orderBy: [{ day: 'asc' }, { startTime: 'asc' }] },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');
    if (trip.itineraries.length === 0) {
      throw new BadRequestException('errors.templates.emptyItinerary');
    }

    const days = new Set(trip.itineraries.map((i) => i.day));
    return this.prisma.itineraryTemplate.create({
      data: {
        authorId: userId,
        sourceTripId: trip.id,
        title: dto.title?.trim() || trip.name,
        description: dto.description?.trim() || trip.description,
        destination: trip.destination,
        coverImage: trip.coverImage,
        vibe: trip.vibe,
        dayCount: Math.max(...days),
        stopCount: trip.itineraries.length,
        isPublic: dto.isPublic ?? true,
        items: {
          create: trip.itineraries.map((i) => ({
            day: i.day,
            startTime: i.startTime,
            placeName: i.placeName,
            placeAddress: i.placeAddress,
            latitude: i.latitude,
            longitude: i.longitude,
            durationMinutes: i.durationMinutes,
            notes: dto.includeNotes ? i.notes : null,
            category: i.category,
          })),
        },
      },
      include: { author: AUTHOR_SELECT },
    });
  }

  /** Mẫu công khai để khám phá. */
  async listPublic(q: ListTemplatesQuery) {
    const term = q.q?.trim();
    const where: Prisma.ItineraryTemplateWhereInput = {
      isPublic: true,
      deletedAt: null,
      ...(q.days ? { dayCount: q.days } : {}),
      ...(term
        ? {
            OR: [
              { title: { contains: term, mode: 'insensitive' } },
              { destination: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.itineraryTemplate.count({ where }),
      this.prisma.itineraryTemplate.findMany({
        where,
        orderBy:
          q.sort === 'new'
            ? [{ createdAt: 'desc' }]
            : [{ useCount: 'desc' }, { createdAt: 'desc' }],
        take: q.limit ?? 20,
        skip: q.offset ?? 0,
        include: { author: AUTHOR_SELECT },
      }),
    ]);
    return { total, items };
  }

  async listMine(userId: string) {
    return this.prisma.itineraryTemplate.findMany({
      where: { authorId: userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { author: AUTHOR_SELECT },
    });
  }

  /** Chi tiết + các điểm dừng. Mẫu riêng tư chỉ tác giả xem được. */
  async findOne(id: string, userId: string) {
    const t = await this.prisma.itineraryTemplate.findUnique({
      where: { id, deletedAt: null },
      include: {
        author: AUTHOR_SELECT,
        items: { orderBy: [{ day: 'asc' }, { startTime: 'asc' }] },
      },
    });
    // Mẫu riêng tư của người khác trả 404 chứ không 403 — không để lộ là nó tồn tại.
    if (!t || (!t.isPublic && t.authorId !== userId)) {
      throw new NotFoundException('errors.templates.notFound');
    }
    return t;
  }

  async update(id: string, userId: string, dto: UpdateTemplateDto) {
    await this.ensureAuthor(id, userId);
    return this.prisma.itineraryTemplate.update({
      where: { id },
      data: {
        title: dto.title?.trim(),
        description: dto.description?.trim(),
        isPublic: dto.isPublic,
      },
      include: { author: AUTHOR_SELECT },
    });
  }

  async remove(id: string, userId: string) {
    await this.ensureAuthor(id, userId);
    await this.prisma.itineraryTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  /**
   * Nhân bản mẫu thành lịch trình của riêng người dùng.
   *
   * - Không có `tripId`: tạo CHUYẾN MỚI qua TripsService.create — nên vẫn chịu
   *   hạn mức chuyến đang hoạt động như tạo tay, không có cửa lách.
   * - Có `tripId`: chép thêm vào chuyến đó (phải là thành viên). Giữ nguyên số
   *   ngày của mẫu; điểm cũ của chuyến không bị xoá.
   *
   * Bản chép là dữ liệu độc lập: sửa/xoá thoải mái, không ảnh hưởng mẫu gốc.
   */
  async duplicate(id: string, userId: string, dto: DuplicateTemplateDto) {
    const t = await this.findOne(id, userId);

    let tripId = dto.tripId;
    let createdTrip = false;
    if (tripId) {
      const member = await this.prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId, userId } },
        include: { trip: { select: { deletedAt: true } } },
      });
      if (!member || member.trip.deletedAt) {
        throw new ForbiddenException('errors.auth.notMember');
      }
    } else {
      const start = dto.startDate
        ? new Date(dto.startDate)
        : new Date(Date.now() + 7 * 86400000);
      const end = new Date(start.getTime() + (t.dayCount - 1) * 86400000);
      const trip = await this.trips.create(userId, {
        name: dto.name?.trim() || t.title,
        description: t.description ?? undefined,
        destination: t.destination ?? undefined,
        coverImage: t.coverImage ?? undefined,
        vibe: t.vibe ?? undefined,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
      });
      tripId = trip.id;
      createdTrip = true;
    }

    try {
      await this.prisma.$transaction([
        this.prisma.itineraryItem.createMany({
          data: t.items.map((i) => ({
            tripId: tripId!,
            day: i.day,
            startTime: i.startTime,
            placeName: i.placeName,
            placeAddress: i.placeAddress,
            latitude: i.latitude,
            longitude: i.longitude,
            durationMinutes: i.durationMinutes,
            notes: i.notes,
            category: i.category,
          })),
        }),
        // Tác giả tự nhân bản mẫu của mình không tính là lượt dùng.
        ...(t.authorId !== userId
          ? [
              this.prisma.itineraryTemplate.update({
                where: { id: t.id },
                data: { useCount: { increment: 1 } },
              }),
            ]
          : []),
      ]);
    } catch (e) {
      // Chép điểm dừng lỗi thì đừng để lại một chuyến rỗng chiếm hạn mức.
      if (createdTrip) {
        await this.prisma.trip
          .delete({ where: { id: tripId } })
          .catch(() => undefined);
      }
      throw e;
    }

    try {
      await this.cache.del(`trip:${tripId}:itinerary`);
    } catch {
      // Cache chỉ là tối ưu; lỗi xoá cache không làm hỏng dữ liệu.
    }
    return { tripId, createdTrip, copiedStops: t.items.length };
  }

  private async ensureAuthor(id: string, userId: string) {
    const t = await this.prisma.itineraryTemplate.findUnique({
      where: { id, deletedAt: null },
      select: { authorId: true },
    });
    if (!t) throw new NotFoundException('errors.templates.notFound');
    if (t.authorId !== userId) {
      throw new ForbiddenException('errors.templates.notAuthor');
    }
  }
}
