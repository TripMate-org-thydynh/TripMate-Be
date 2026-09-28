import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateItineraryItemDto } from './dto/create-itinerary-item.dto';
import { UpdateItineraryItemDto } from './dto/update-itinerary-item.dto';
import { GeocodingService } from './geocoding.service';

@Injectable()
export class ItinerariesService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly activities: ActivitiesService,
    private readonly geocoding: GeocodingService,
  ) {}

  async create(tripId: string, dto: CreateItineraryItemDto, userId?: string) {
    const item = await this.prisma.itineraryItem.create({
      data: {
        tripId,
        day: dto.day,
        startTime: dto.startTime,
        placeName: dto.placeName,
        placeAddress: dto.placeAddress,
        placeId: dto.placeId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        durationMinutes: dto.durationMinutes,
        notes: dto.notes,
        category: dto.category,
      },
    });
    // Ghi nhật ký hoạt động để feed squad (marquee, Live Updates, Daily Recap)
    // có dữ liệu. Trước đây ActivitiesService.log() không nơi nào gọi.
    if (userId) {
      await this.activities.log(
        tripId,
        userId,
        'ITINERARY_ADDED',
        {
          placeName: item.placeName,
          day: item.day,
        },
        item.id,
      );
    }
    await this.evictCache(tripId);
    if (item.latitude == null) void this.geocodeInBackground(item.id, tripId);
    return item;
  }

  async findAll(tripId: string) {
    const cacheKey = `trip:${tripId}:itinerary`;
    try {
      const cached = await this.cacheManager.get<any[]>(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (e) {
      console.error('Redis cache get error:', e.message);
    }

    const items = await this.prisma.itineraryItem.findMany({
      where: { tripId },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
    });

    try {
      await this.cacheManager.set(cacheKey, items, 300000); // 5 minutes cache
    } catch (e) {
      console.error('Redis cache set error:', e.message);
    }

    return items;
  }

  async findOne(id: string, tripId: string) {
    const item = await this.prisma.itineraryItem.findUnique({ where: { id } });
    if (!item || item.tripId !== tripId) {
      throw new NotFoundException('Itinerary item not found in this trip');
    }
    return item;
  }

  async update(id: string, tripId: string, dto: UpdateItineraryItemDto) {
    await this.findOne(id, tripId);
    const updated = await this.prisma.itineraryItem.update({
      where: { id },
      data: {
        day: dto.day,
        startTime: dto.startTime,
        placeName: dto.placeName,
        placeAddress: dto.placeAddress,
        placeId: dto.placeId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        durationMinutes: dto.durationMinutes,
        notes: dto.notes,
        category: dto.category,
      },
    });
    await this.evictCache(tripId);
    // Đổi địa điểm mà không kèm toạ độ → toạ độ cũ không còn đúng, tìm lại.
    const placeChanged =
      dto.placeName !== undefined || dto.placeAddress !== undefined;
    if (placeChanged && dto.latitude === undefined) {
      void this.geocodeInBackground(id, tripId, true);
    }
    return updated;
  }

  /**
   * Bù toạ độ cho các điểm dừng chưa có (điểm cũ, hoặc tạo tay chỉ gõ tên).
   * Trả về toàn bộ điểm của ngày đó (hoặc cả chuyến) sau khi bù.
   *
   * Tối đa [limit] điểm mỗi lượt vì Nominatim chỉ cho 1 request/giây.
   */
  async geocodeMissing(tripId: string, day?: number, limit = 20) {
    const missing = await this.prisma.itineraryItem.findMany({
      where: { tripId, ...(day ? { day } : {}), latitude: null },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
      take: limit,
    });
    let found = 0;
    for (const item of missing) {
      const p = await this.geocoding.locate(item.placeName, item.placeAddress);
      if (!p) continue;
      await this.prisma.itineraryItem.update({
        where: { id: item.id },
        data: { latitude: p.latitude, longitude: p.longitude },
      });
      found++;
    }
    if (found) await this.evictCache(tripId);
    const items = await this.prisma.itineraryItem.findMany({
      where: { tripId, ...(day ? { day } : {}) },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
    });
    return { attempted: missing.length, found, items };
  }

  private async geocodeInBackground(id: string, tripId: string, force = false) {
    try {
      const item = await this.prisma.itineraryItem.findUnique({
        where: { id },
      });
      if (!item || (!force && item.latitude != null)) return;
      const p = await this.geocoding.locate(item.placeName, item.placeAddress);
      await this.prisma.itineraryItem.update({
        where: { id },
        data: p
          ? { latitude: p.latitude, longitude: p.longitude }
          : { latitude: null, longitude: null },
      });
      await this.evictCache(tripId);
    } catch {
      // Điểm có thể đã bị xoá trong lúc chờ — bỏ qua.
    }
  }

  async remove(id: string, tripId: string) {
    await this.findOne(id, tripId);
    const deleted = await this.prisma.itineraryItem.delete({ where: { id } });
    await this.evictCache(tripId);
    return deleted;
  }

  private async evictCache(tripId: string) {
    try {
      await this.cacheManager.del(`trip:${tripId}:itinerary`);
    } catch (e) {
      console.error('Redis cache eviction error:', e.message);
    }
  }
}
