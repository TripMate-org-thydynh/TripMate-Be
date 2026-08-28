import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMomentDto } from './dto/create-moment.dto';

@Injectable()
export class MomentsService {
  constructor(private prisma: PrismaService) {}

  async create(tripId: string, userId: string, dto: CreateMomentDto) {
    return this.prisma.moment.create({
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
  }

  async findAll(tripId: string) {
    return this.prisma.moment.findMany({
      where: { tripId, deletedAt: null },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { reactions: true, comments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
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
  async delete(id: string, userId: string) {
    const moment = await this.prisma.moment.findUnique({ where: { id } });
    if (!moment) throw new NotFoundException('errors.database.notFound');
    return this.prisma.moment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addComment(momentId: string, userId: string, content: string) {
    return this.prisma.momentComment.create({
      data: { momentId, userId, content },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async toggleReaction(momentId: string, userId: string, emoji: string) {
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
