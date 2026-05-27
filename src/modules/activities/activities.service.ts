import { Injectable } from '@nestjs/common';
import { ActivityType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ActivitiesService {
  constructor(private prisma: PrismaService) {}

  async log(
    tripId: string,
    userId: string,
    type: ActivityType,
    data: object = {},
  ) {
    return this.prisma.activity.create({
      data: { tripId, userId, type, data },
    });
  }

  async findByTrip(tripId: string, limit = 50) {
    return this.prisma.activity.findMany({
      where: { tripId },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
