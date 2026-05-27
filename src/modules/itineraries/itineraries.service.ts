import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateItineraryItemDto } from './dto/create-itinerary-item.dto';
import { UpdateItineraryItemDto } from './dto/update-itinerary-item.dto';

@Injectable()
export class ItinerariesService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async create(tripId: string, dto: CreateItineraryItemDto) {
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
      },
    });
    await this.evictCache(tripId);
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
      },
    });
    await this.evictCache(tripId);
    return updated;
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
