import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { JoinTripDto } from './dto/join-trip.dto';

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join('');
}

@Injectable()
export class TripsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateTripDto) {
    let inviteCode: string;
    let attempts = 0;
    do {
      inviteCode = generateInviteCode();
      if (++attempts > 10)
        throw new Error('Could not generate unique invite code');
    } while (await this.prisma.trip.findUnique({ where: { inviteCode } }));

    return this.prisma.trip.create({
      data: {
        name: dto.name,
        description: dto.description,
        destination: dto.destination,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        coverImage: dto.coverImage,
        currency: dto.currency ?? 'VND',
        budget: dto.budget,
        vibe: dto.vibe,
        theme: dto.theme,
        isPublic: dto.isPublic ?? false,
        inviteCode,
        createdBy: userId,
        members: { create: { userId, role: 'CREATOR' } },
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { members: true } },
      },
    });
  }

  async findOne(tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId, deletedAt: null },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                avatarUrl: true,
                presence: true,
              },
            },
          },
        },
        _count: {
          select: { moments: true, expenses: true, chatMessages: true },
        },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');
    return trip;
  }

  async update(tripId: string, userId: string, dto: UpdateTripDto) {
    await this.ensureCreator(tripId, userId);
    return this.prisma.trip.update({
      where: { id: tripId },
      data: {
        name: dto.name,
        description: dto.description,
        destination: dto.destination,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        coverImage: dto.coverImage,
        currency: dto.currency,
        budget: dto.budget,
        vibe: dto.vibe,
        theme: dto.theme,
        isPublic: dto.isPublic,
      },
    });
  }

  async delete(tripId: string, userId: string) {
    await this.ensureCreator(tripId, userId);
    return this.prisma.trip.update({
      where: { id: tripId },
      data: { deletedAt: new Date() },
    });
  }

  async join(userId: string, dto: JoinTripDto) {
    const trip = await this.prisma.trip.findUnique({
      where: { inviteCode: dto.inviteCode, deletedAt: null },
    });
    if (!trip) throw new NotFoundException('errors.trips.invalidInviteCode');

    const existing = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId: trip.id, userId } },
    });
    if (existing) throw new ConflictException('errors.trips.alreadyMember');

    await this.prisma.tripMember.create({
      data: { tripId: trip.id, userId, role: 'MEMBER' },
    });
    return this.findOne(trip.id);
  }

  async leave(tripId: string, userId: string) {
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
    if (!member) throw new NotFoundException('errors.auth.notMember');
    if (member.role === 'CREATOR') {
      throw new ForbiddenException('errors.auth.creatorCannotLeave');
    }
    return this.prisma.tripMember.delete({
      where: { tripId_userId: { tripId, userId } },
    });
  }

  async getMembers(tripId: string) {
    return this.prisma.tripMember.findMany({
      where: { tripId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            avatarUrl: true,
            travelScore: true,
            presence: true,
          },
        },
      },
    });
  }

  async removeMember(
    tripId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    await this.ensureCreator(tripId, requesterId);
    if (requesterId === targetUserId) {
      throw new ForbiddenException('errors.trips.creatorCannotLeave');
    }
    return this.prisma.tripMember.delete({
      where: { tripId_userId: { tripId, userId: targetUserId } },
    });
  }

  async regenerateInviteCode(tripId: string, userId: string) {
    await this.ensureCreator(tripId, userId);
    let inviteCode: string;
    do {
      inviteCode = generateInviteCode();
    } while (await this.prisma.trip.findUnique({ where: { inviteCode } }));
    return this.prisma.trip.update({
      where: { id: tripId },
      data: { inviteCode },
    });
  }

  private async ensureCreator(tripId: string, userId: string) {
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
    if (!member) throw new NotFoundException('errors.trips.notFound');
    if (member.role !== 'CREATOR') {
      throw new ForbiddenException('errors.trips.onlyCreator');
    }
  }

  /**
   * Số liệu tổng kết chuyến (Trip Wrapped).
   *
   * Màn Trip Wrapped và AI Trip Summary trước đây in cứng "7 địa điểm",
   * "142 khoảnh khắc", "186 km", MVP "Thảo Ly" — giống hệt nhau ở mọi chuyến,
   * mọi tài khoản. Đây là số đếm thật từ DB; MVP tính theo cùng công thức đóng
   * góp với bảng xếp hạng (khoảnh khắc 40đ, chi 20đ, điểm lịch trình 30đ,
   * ghi chú 15đ).
   */
  async getRecap(tripId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    const userIds = trip.members.map((m) => m.userId);
    const [
      places,
      momentCount,
      expenses,
      moments,
      recentMoments,
      expenseRows,
      plans,
      notes,
    ] = await Promise.all([
      this.prisma.itineraryItem.count({ where: { tripId } }),
      this.prisma.moment.count({ where: { tripId, deletedAt: null } }),
      this.prisma.expense.aggregate({
        where: { tripId },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.moment.groupBy({
        by: ['userId'],
        where: { tripId, deletedAt: null, userId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.moment.findMany({
        where: { tripId, deletedAt: null },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
          _count: { select: { reactions: true, comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.expense.groupBy({
        by: ['paidById'],
        where: { tripId, paidById: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.activity.groupBy({
        by: ['userId'],
        where: { tripId, type: 'ITINERARY_ADDED', userId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.tripNote.groupBy({
        by: ['authorId'],
        where: { tripId, authorId: { in: userIds } },
        _count: { _all: true },
      }),
    ]);

    type GroupRow = { _count: { _all: number } } & Record<string, unknown>;
    const countOf = (rows: GroupRow[], key: string, id: string) =>
      rows.find((r) => r[key] === id)?._count._all ?? 0;

    const ranked = trip.members
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        moments: countOf(moments, 'userId', m.userId),
        expenses: countOf(expenseRows, 'paidById', m.userId),
        xp:
          countOf(moments, 'userId', m.userId) * 40 +
          countOf(expenseRows, 'paidById', m.userId) * 20 +
          countOf(plans, 'userId', m.userId) * 30 +
          countOf(notes, 'authorId', m.userId) * 15,
      }))
      .sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));

    // Số ngày tính cả ngày đầu và ngày cuối.
    const msPerDay = 24 * 60 * 60 * 1000;
    const days =
      Math.floor(
        (trip.endDate.getTime() - trip.startDate.getTime()) / msPerDay,
      ) + 1;

    const mvp = ranked[0];
    return {
      tripId,
      tripName: trip.name,
      destination: trip.destination,
      coverImage: trip.coverImage,
      startDate: trip.startDate,
      endDate: trip.endDate,
      days: days > 0 ? days : 1,
      memberCount: trip.members.length,
      members: trip.members.map((m) => ({
        id: m.userId,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
      })),
      placeCount: places,
      momentCount,
      expenseCount: expenses._count._all,
      totalSpent: Number(expenses._sum.amount ?? 0),
      currency: trip.currency,
      moments: recentMoments.map((m) => ({
        id: m.id,
        mediaUrl: m.mediaUrl,
        posterUrl: StorageService.posterFor(m.mediaUrl, m.type, 900),
        type: m.type,
        caption: m.caption,
        authorName: m.user.name,
        authorAvatarUrl: m.user.avatarUrl,
        reactionCount: m._count.reactions,
        commentCount: m._count.comments,
        createdAt: m.createdAt,
      })),
      // null khi cả nhóm chưa đóng góp gì — client hiện trạng thái rỗng.
      mvp: mvp && mvp.xp > 0 ? mvp : null,
      hasData: places + momentCount + expenses._count._all > 0,
    };
  }
}
