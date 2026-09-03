import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // --- STATISTICS ---
  async getStats() {
    const [
      totalUsers,
      totalTrips,
      totalExpenses,
      totalMoments,
      totalReservations,
      activeUsers,
      recentActivities,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.trip.count(),
      this.prisma.expense.count(),
      this.prisma.moment.count(),
      this.prisma.reservation.count(),
      this.prisma.userPresence.count({
        where: {
          status: { in: ['ONLINE', 'IN_TRIP'] },
        },
      }),
      this.prisma.activity.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, avatarUrl: true },
          },
          trip: {
            select: { id: true, name: true },
          },
        },
      }),
    ]);

    const formattedActivities = recentActivities.map((a) => ({
      id: a.id,
      type: a.type,
      description:
        typeof a.data === 'object' && a.data !== null
          ? (((a.data as Record<string, unknown>)['description'] as string) ??
            `${a.type} hoạt động`)
          : `${a.type} hoạt động`,
      createdAt: a.createdAt,
      user: a.user,
      trip: a.trip,
    }));

    return {
      totalUsers,
      totalTrips,
      totalExpenses,
      totalMoments,
      totalReservations,
      activeUsers,
      recentActivities: formattedActivities,
    };
  }

  // --- ANALYTICS ---
  async getGrowthAnalytics() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [users, trips] = await Promise.all([
      this.prisma.user.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.trip.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Group by YYYY-MM-DD
    const dateMap: Record<
      string,
      { date: string; users: number; trips: number }
    > = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dateMap[key] = { date: key, users: 0, trips: 0 };
    }

    users.forEach((u) => {
      const key = u.createdAt.toISOString().split('T')[0];
      if (dateMap[key]) dateMap[key].users += 1;
    });

    trips.forEach((t) => {
      const key = t.createdAt.toISOString().split('T')[0];
      if (dateMap[key]) dateMap[key].trips += 1;
    });

    return {
      dailyGrowth: Object.values(dateMap),
      totalUsersLast30Days: users.length,
      totalTripsLast30Days: trips.length,
    };
  }

  async getRevenueAnalytics() {
    const [transactions, walletCount] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        select: { amount: true, status: true, provider: true, createdAt: true },
      }),
      this.prisma.userWallet.count(),
    ]);

    const totalVolume = transactions
      .filter((t) => t.status === 'SUCCESS')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const statusBreakdown: Record<string, number> = {};
    const methodBreakdown: Record<string, number> = {};

    transactions.forEach((t) => {
      statusBreakdown[t.status] = (statusBreakdown[t.status] || 0) + 1;
      const method = t.provider || 'CASH';
      methodBreakdown[method] = (methodBreakdown[method] || 0) + 1;
    });

    // Estimate MRR (Monthly Recurring Revenue) based on completed transactions in last 30d
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const mrr = transactions
      .filter((t) => t.status === 'SUCCESS' && t.createdAt >= thirtyDaysAgo)
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    return {
      totalVolume,
      mrr,
      totalTransactions: transactions.length,
      walletCount,
      statusBreakdown,
      methodBreakdown,
    };
  }

  async getAiAnalytics() {
    const [totalRequests, requests] = await Promise.all([
      this.prisma.aIRequest.count(),
      this.prisma.aIRequest.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        select: { type: true, createdAt: true },
      }),
    ]);

    const typeBreakdown: Record<string, number> = {};
    requests.forEach((r) => {
      const type = r.type || 'GENERAL';
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
    });

    return {
      totalRequests,
      recentRequestsCount: requests.length,
      typeBreakdown,
    };
  }

  // --- USER MANAGEMENT ---
  async getUsers(search?: string, role?: UserRole, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role;
    }

    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          presence: true,
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        presence: true,
        _count: {
          select: {
            tripsCreated: true,
            tripMembers: true,
            expensesPaid: true,
            moments: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(
    id: string,
    data: { role?: UserRole; isLocked?: boolean; bio?: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async deleteUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    // Soft delete
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // --- TRIP CRUD ---
  async getTrips(search?: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { destination: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          creator: { select: { id: true, name: true, avatarUrl: true } },
          _count: { select: { members: true, itineraries: true } },
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  async createTrip(data: {
    name: string;
    destination?: string;
    startDate: Date;
    endDate: Date;
    createdBy: string;
  }) {
    // Generate a unique invite code
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    return this.prisma.trip.create({
      data: {
        ...data,
        inviteCode,
      },
    });
  }

  async updateTrip(id: string, data: any) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');

    return this.prisma.trip.update({
      where: { id },
      data,
    });
  }

  async deleteTrip(id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');

    // Soft delete
    return this.prisma.trip.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // --- RESERVATION CRUD ---
  async getReservations(page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [total, items] = await Promise.all([
      this.prisma.reservation.count(),
      this.prisma.reservation.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          trip: { select: { id: true, name: true } },
          addedByUser: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page, limit, totalPages: Math.ceil(total / limit), items };
  }

  async createReservation(data: any) {
    return this.prisma.reservation.create({ data });
  }

  async updateReservation(id: string, data: any) {
    const res = await this.prisma.reservation.findUnique({ where: { id } });
    if (!res) throw new NotFoundException('Reservation not found');
    return this.prisma.reservation.update({ where: { id }, data });
  }

  async deleteReservation(id: string) {
    const res = await this.prisma.reservation.findUnique({ where: { id } });
    if (!res) throw new NotFoundException('Reservation not found');
    return this.prisma.reservation.delete({ where: { id } });
  }

  // --- JOURNAL CRUD ---
  async getJournals(page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [total, items] = await Promise.all([
      this.prisma.journalEntry.count(),
      this.prisma.journalEntry.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          trip: { select: { id: true, name: true } },
          author: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page, limit, totalPages: Math.ceil(total / limit), items };
  }

  async createJournal(data: any) {
    return this.prisma.journalEntry.create({ data });
  }

  async updateJournal(id: string, data: any) {
    const journal = await this.prisma.journalEntry.findUnique({
      where: { id },
    });
    if (!journal) throw new NotFoundException('Journal not found');
    return this.prisma.journalEntry.update({ where: { id }, data });
  }

  async deleteJournal(id: string) {
    const journal = await this.prisma.journalEntry.findUnique({
      where: { id },
    });
    if (!journal) throw new NotFoundException('Journal not found');
    return this.prisma.journalEntry.delete({ where: { id } });
  }

  // --- PACKING CRUD ---
  async getPackingItems(page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [total, items] = await Promise.all([
      this.prisma.packingItem.count(),
      this.prisma.packingItem.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          trip: { select: { id: true, name: true } },
          addedByUser: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page, limit, totalPages: Math.ceil(total / limit), items };
  }

  async createPackingItem(data: any) {
    return this.prisma.packingItem.create({ data });
  }

  async updatePackingItem(id: string, data: any) {
    const packing = await this.prisma.packingItem.findUnique({ where: { id } });
    if (!packing) throw new NotFoundException('Packing item not found');
    return this.prisma.packingItem.update({ where: { id }, data });
  }

  async deletePackingItem(id: string) {
    const packing = await this.prisma.packingItem.findUnique({ where: { id } });
    if (!packing) throw new NotFoundException('Packing item not found');
    return this.prisma.packingItem.delete({ where: { id } });
  }

  // --- CONFIG MANAGEMENT ---
  async getConfigs() {
    return this.prisma.systemConfig.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async updateConfig(key: string, value: string, description?: string) {
    return this.prisma.systemConfig.upsert({
      where: { key },
      create: { key, value, description },
      update: { value, ...(description ? { description } : {}) },
    });
  }
}
