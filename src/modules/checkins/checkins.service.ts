import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpsertCheckinDto } from './dto/upsert-checkin.dto';

@Injectable()
export class CheckinsService {
  constructor(private prisma: PrismaService) {}

  async getAll(tripId: string) {
    return this.prisma.dayCheckin.findMany({
      where: { tripId },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: [{ day: 'asc' }, { user: { name: 'asc' } }],
    });
  }

  async upsert(tripId: string, userId: string, dto: UpsertCheckinDto) {
    return this.prisma.dayCheckin.upsert({
      where: {
        tripId_userId_day: { tripId, userId, day: dto.day },
      },
      create: {
        tripId,
        userId,
        day: dto.day,
        status: dto.status,
        note: dto.note,
      },
      update: {
        status: dto.status,
        note: dto.note,
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }
}
