import { Injectable, Logger } from '@nestjs/common';
import { ActivityType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { XpService } from '../xp/xp.service';

@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(
    private prisma: PrismaService,
    private xp: XpService,
  ) {}

  /**
   * Ghi một hoạt động vào feed và cộng XP cho người làm.
   *
   * [refId] là id của thực thể vừa tạo (khoản chi, khoảnh khắc...). Truyền vào
   * để cùng một thực thể không bao giờ được thưởng hai lần — kể cả khi client
   * gọi lại vì mạng chập chờn.
   *
   * XP hỏng KHÔNG được làm hỏng hành động chính: người dùng đã ghi xong khoản
   * chi thì không thể vì lỗi cộng điểm mà báo thất bại.
   */
  async log(
    tripId: string,
    userId: string,
    type: ActivityType,
    data: object = {},
    refId?: string,
  ) {
    const activity = await this.prisma.activity.create({
      data: { tripId, userId, type, data },
    });

    try {
      await this.xp.awardForActivity(userId, type, {
        refId: refId ?? activity.id,
        tripId,
      });
    } catch (e) {
      this.logger.error(
        `Cộng XP thất bại (user=${userId} type=${type}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    return activity;
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
