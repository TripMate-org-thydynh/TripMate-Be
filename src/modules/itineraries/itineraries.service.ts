import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateItineraryItemDto } from './dto/create-itinerary-item.dto';
import { UpdateItineraryItemDto } from './dto/update-itinerary-item.dto';

@Injectable()
export class ItinerariesService {
  constructor(private prisma: PrismaService) {}

  async create(tripId: string, dto: CreateItineraryItemDto) {
    return this.prisma.itineraryItem.create({
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
  }

  async findAll(tripId: string) {
    return this.prisma.itineraryItem.findMany({
      where: { tripId },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.itineraryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Itinerary item not found');
    return item;
  }

  async update(id: string, dto: UpdateItineraryItemDto) {
    await this.findOne(id);
    return this.prisma.itineraryItem.update({
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
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.itineraryItem.delete({ where: { id } });
  }
}
