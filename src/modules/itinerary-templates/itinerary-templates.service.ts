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
import { AiService } from '../ai/ai.service';
import { ItinerariesService } from '../itineraries/itineraries.service';
import {
  RateTemplateDto,
  CustomizeTemplateDto,
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
    private readonly ai: AiService,
    private readonly itineraries: ItinerariesService,
  ) {}

  /**
   * AI chỉnh mẫu theo nhóm (số người, ngân sách, số ngày, sở thích).
   *
   * Chỉ là BẢN XEM TRƯỚC — không ghi gì. Tính vào hạn mức AI/tháng. Điểm nào
   * trùng tên với mẫu thì mang theo toạ độ của mẫu.
   */
  async customize(id: string, userId: string, dto: CustomizeTemplateDto) {
    const t = await this.findOne(id, userId);
    const res = await this.ai.customizeItinerary(userId, {
      title: t.title,
      destination: t.destination,
      dayCount: t.dayCount,
      items: t.items.map((i) => ({
        day: i.day,
        startTime: i.startTime,
        placeName: i.placeName,
        placeAddress: i.placeAddress,
        durationMinutes: i.durationMinutes,
        category: i.category,
      })),
      request: dto.request,
      groupSize: dto.groupSize,
      budget: dto.budget,
      days: dto.days,
    });
    const coords = this.coordsByName(t.items);
    return {
      ...res,
      items: res.items.map((i) => ({
        ...i,
        ...(coords.get(i.placeName.toLowerCase()) ?? {
          latitude: null,
          longitude: null,
        }),
        fromTemplate: coords.has(i.placeName.toLowerCase()),
      })),
    };
  }

  private coordsByName(
    items: { placeName: string; latitude: unknown; longitude: unknown }[],
  ) {
    const m = new Map<string, { latitude: number; longitude: number }>();
    for (const i of items) {
      if (i.latitude != null && i.longitude != null) {
        m.set(i.placeName.toLowerCase(), {
          latitude: Number(i.latitude),
          longitude: Number(i.longitude),
        });
      }
    }
    return m;
  }

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
        tags: dto.tags ?? [],
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
      ...(q.tag ? { tags: { has: q.tag } } : {}),
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
            : q.sort === 'top'
              ? [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }]
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
        tags: dto.tags,
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

    // Bản AI đã chỉnh (người dùng đã xem trước) thay cho điểm của mẫu. Điểm trùng
    // tên với mẫu giữ toạ độ; điểm mới để backend tự tìm sau.
    const coords = this.coordsByName(t.items);
    const source = dto.items?.length
      ? dto.items.map((i) => ({
          day: i.day,
          startTime: i.startTime,
          placeName: i.placeName.trim(),
          placeAddress: i.placeAddress?.trim() || null,
          latitude:
            coords.get(i.placeName.trim().toLowerCase())?.latitude ?? null,
          longitude:
            coords.get(i.placeName.trim().toLowerCase())?.longitude ?? null,
          durationMinutes: i.durationMinutes,
          notes: i.notes?.trim() || null,
          category: i.category ?? 'OTHER',
        }))
      : t.items;
    const dayCount = Math.max(...source.map((i) => i.day), 1);

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
      const end = new Date(start.getTime() + (dayCount - 1) * 86400000);
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
          data: source.map((i) => ({
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
        // Ghi nhận người này đã dùng mẫu — điều kiện để được chấm sao.
        this.prisma.itineraryTemplateUse.upsert({
          where: { templateId_userId: { templateId: t.id, userId } },
          create: { templateId: t.id, userId },
          update: {},
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
    if (source.some((i) => i.latitude == null)) {
      // Tìm toạ độ chạy nền (Nominatim 1 req/giây) — không bắt người dùng chờ.
      void this.itineraries.geocodeMissing(tripId!).catch(() => undefined);
    }
    return { tripId, createdTrip, copiedStops: source.length };
  }

  /**
   * Mục "Mẫu nổi bật": mẫu admin ghim trước, rồi mẫu có điểm cao.
   *
   * Điểm dùng trung bình có trọng số (Bayes, m=3, trung bình gốc 3.5): một mẫu
   * chỉ có MỘT lượt 5 sao không vượt được mẫu có hai chục lượt 4.6 sao.
   */
  async featured(limit = 6) {
    const pool = await this.prisma.itineraryTemplate.findMany({
      where: {
        isPublic: true,
        deletedAt: null,
        OR: [
          { isFeatured: true },
          { ratingCount: { gte: 1 } },
          { useCount: { gte: 1 } },
        ],
      },
      include: { author: AUTHOR_SELECT },
      take: 100,
    });
    const m = 3;
    const prior = 3.5;
    const score = (t: (typeof pool)[number]) =>
      (t.isFeatured ? 100 : 0) +
      (t.ratingCount * t.ratingAvg + m * prior) / (t.ratingCount + m) +
      Math.log10(1 + t.useCount) * 0.3;
    return pool.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  /**
   * Chấm sao một mẫu. Chỉ người ĐÃ DÙNG mẫu (nhân bản ít nhất một lần) mới
   * chấm được, và tác giả không tự chấm mẫu của mình — không thì điểm vô nghĩa.
   * Chấm lại thì sửa lượt cũ, không cộng thêm.
   */
  async rate(id: string, userId: string, dto: RateTemplateDto) {
    const t = await this.findOne(id, userId);
    if (t.authorId === userId) {
      throw new ForbiddenException('errors.templates.cannotRateOwn');
    }
    const used = await this.prisma.itineraryTemplateUse.findUnique({
      where: { templateId_userId: { templateId: id, userId } },
    });
    if (!used) throw new ForbiddenException('errors.templates.mustUseFirst');

    return this.prisma.$transaction(async (tx) => {
      await tx.itineraryTemplateRating.upsert({
        where: { templateId_userId: { templateId: id, userId } },
        create: {
          templateId: id,
          userId,
          stars: dto.stars,
          comment: dto.comment?.trim() || null,
        },
        update: { stars: dto.stars, comment: dto.comment?.trim() || null },
      });
      // Tính lại từ bảng đánh giá thay vì cộng dồn — không bao giờ lệch.
      const agg = await tx.itineraryTemplateRating.aggregate({
        where: { templateId: id },
        _avg: { stars: true },
        _count: true,
      });
      return tx.itineraryTemplate.update({
        where: { id },
        data: {
          ratingAvg: Math.round((agg._avg.stars ?? 0) * 10) / 10,
          ratingCount: agg._count,
        },
        select: { id: true, ratingAvg: true, ratingCount: true },
      });
    });
  }

  /** Trạng thái của người đang xem với mẫu: đã dùng chưa, đã chấm mấy sao. */
  async myState(id: string, userId: string) {
    const [use, rating] = await Promise.all([
      this.prisma.itineraryTemplateUse.findUnique({
        where: { templateId_userId: { templateId: id, userId } },
      }),
      this.prisma.itineraryTemplateRating.findUnique({
        where: { templateId_userId: { templateId: id, userId } },
      }),
    ]);
    return { used: !!use, myStars: rating?.stars ?? null };
  }

  async recentRatings(id: string) {
    return this.prisma.itineraryTemplateRating.findMany({
      where: { templateId: id, comment: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  /** Admin ghim/bỏ ghim mẫu nổi bật. */
  async setFeatured(id: string, isFeatured: boolean) {
    return this.prisma.itineraryTemplate.update({
      where: { id },
      data: { isFeatured },
      select: { id: true, isFeatured: true },
    });
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
