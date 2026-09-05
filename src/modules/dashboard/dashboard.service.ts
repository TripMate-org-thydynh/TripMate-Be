import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getSummary(userId: string) {
    // Lấy chuyến đi gần nhất hoặc đang diễn ra
    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        members: { some: { userId } },
        deletedAt: null,
        endDate: { gte: new Date() },
      },
      orderBy: { startDate: 'asc' },
      include: {
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

    // Tổng chi tiêu chuyến đi
    let totalExpenses = 0;
    let paidExpenses = 0;

    if (activeTrip) {
      const expenses = await this.prisma.expense.aggregate({
        where: { tripId: activeTrip.id },
        _sum: { amount: true },
      });
      totalExpenses = Number(expenses._sum.amount ?? 0);

      const paid = await this.prisma.expenseSplit.aggregate({
        where: {
          expense: { tripId: activeTrip.id },
          isPaid: true,
        },
        _sum: { shareAmount: true },
      });
      paidExpenses = Number(paid._sum?.shareAmount ?? 0);
    }

    const progressPercent =
      totalExpenses > 0
        ? Math.min(Math.round((paidExpenses / totalExpenses) * 100), 100)
        : 0;

    return {
      activeTrip: activeTrip
        ? {
            id: activeTrip.id,
            name: activeTrip.name,
            description: activeTrip.description,
            startDate: activeTrip.startDate,
            endDate: activeTrip.endDate,
            coverImage: activeTrip.coverImage,
            memberCount: activeTrip.members.length,
            activeEditors: activeTrip.members.filter(
              (m) =>
                m.user.presence?.status === 'ONLINE' ||
                m.user.presence?.status === 'IN_TRIP',
            ).length,
            momentCount: activeTrip._count.moments,
            expenseCount: activeTrip._count.expenses,
            chatCount: activeTrip._count.chatMessages,
            progressPercent,
            totalExpenses,
          }
        : null,
    };
  }

  async getSquadOnline(userId: string) {
    // Lấy trip đang active của user
    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        members: { some: { userId } },
        deletedAt: null,
        endDate: { gte: new Date() },
      },
      orderBy: { startDate: 'asc' },
    });

    if (!activeTrip) {
      return { members: [] };
    }

    const members = await this.prisma.tripMember.findMany({
      where: { tripId: activeTrip.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            avatarUrl: true,
            vibeTags: true,
            presence: true,
          },
        },
      },
    });

    return {
      tripId: activeTrip.id,
      tripName: activeTrip.name,
      members: members.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        username: m.user.username,
        avatarUrl: m.user.avatarUrl,
        vibeTags: m.user.vibeTags,
        status: m.user.presence?.status ?? 'OFFLINE',
        lastSeen: m.user.presence?.lastSeen,
        role: m.role,
      })),
    };
  }

  async getRecentActivities(userId: string) {
    // Lấy hoạt động gần đây từ các chuyến đi của user
    const activities = await this.prisma.activity.findMany({
      where: {
        trip: {
          members: { some: { userId } },
          deletedAt: null,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        user: {
          select: { id: true, name: true, avatarUrl: true },
        },
        trip: {
          select: { id: true, name: true },
        },
      },
    });

    return {
      activities: activities.map((a) => ({
        id: a.id,
        type: a.type,
        // Activity model uses 'data' (JSON) not 'description'
        description:
          typeof a.data === 'object' && a.data !== null
            ? (((a.data as Record<string, unknown>)['description'] as
                | string
                | undefined) ?? `${a.type} hoạt động`)
            : `${a.type} hoạt động`,
        createdAt: a.createdAt,
        user: a.user,
        trip: a.trip,
      })),
    };
  }
}
