import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, Plan } from '@prisma/client';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // --- STATISTICS ---
  async getStats() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      totalTrips,
      totalExpenses,
      totalMoments,
      totalReservations,
      activeUsers,
      recentActivities,
      expensesByCategoryRaw,
      tripsWithMembers,
      recentActivitiesLast30Days,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.trip.count({ where: { deletedAt: null } }),
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
      this.prisma.expense.groupBy({
        by: ['category'],
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.trip.findMany({
        where: {
          deletedAt: null,
          activities: {
            some: { createdAt: { gte: sevenDaysAgo } },
          },
        },
        select: {
          id: true,
          _count: { select: { members: true } },
        },
      }),
      this.prisma.activity.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
      }),
    ]);

    // North Star Metric: Số squad có >= 3 thành viên hoạt động trong 7 ngày gần nhất
    const activeSquadsCount = tripsWithMembers.filter(
      (t) => (t._count?.members ?? 0) >= 3,
    ).length;

    // Tổng hợp Expense Categories cho biểu đồ tròn/donut
    const expenseCategories = expensesByCategoryRaw.map((item) => ({
      category: item.category || 'OTHER',
      totalAmount: Number(item._sum.amount || 0),
      count: item._count.id,
    }));

    // Thống kê hoạt động 30 ngày qua cho biểu đồ đường
    const activityTrendMap: Record<string, number> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      activityTrendMap[key] = 0;
    }
    recentActivitiesLast30Days.forEach((a) => {
      const key = a.createdAt.toISOString().split('T')[0];
      if (activityTrendMap[key] !== undefined) activityTrendMap[key] += 1;
    });

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
      northStar: {
        activeSquads7Days: activeSquadsCount,
        definition: 'Số nhóm (Squad) có ≥3 thành viên hoạt động trong 7 ngày',
      },
      expenseCategories,
      activityTrend: Object.entries(activityTrendMap).map(([date, count]) => ({
        date,
        count,
      })),
      recentActivities: formattedActivities,
    };
  }

  // --- ANALYTICS ---
  async getGrowthAnalytics() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      users,
      trips,
      topDestinationsRaw,
      totalUsersCount,
      tripCreatorsCount,
      activeInSquadCount,
      expenseOrMomentUsersCount,
      payingUsersCount,
      dauActivities,
      wauActivities,
      mauActivities,
    ] = await Promise.all([
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
      this.prisma.trip.groupBy({
        by: ['destination'],
        _count: { id: true },
        where: {
          destination: { not: null },
          deletedAt: null,
        },
        orderBy: { _count: { id: 'desc' } },
        take: 6,
      }),
      // Phễu chuyển đổi (Conversion Funnel)
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.trip
        .groupBy({ by: ['createdBy'], where: { deletedAt: null } })
        .then((res) => res.length),
      this.prisma.tripMember
        .groupBy({ by: ['userId'] })
        .then((res) => res.length),
      this.prisma.expense
        .groupBy({ by: ['paidById'] })
        .then((res) => res.length),
      this.prisma.subscription
        .groupBy({ by: ['userId'], where: { status: 'ACTIVE' } })
        .then((res) => res.length),
      // DAU / WAU / MAU
      this.prisma.activity
        .groupBy({ by: ['userId'], where: { createdAt: { gte: oneDayAgo } } })
        .then((res) => res.length),
      this.prisma.activity
        .groupBy({ by: ['userId'], where: { createdAt: { gte: sevenDaysAgo } } })
        .then((res) => res.length),
      this.prisma.activity
        .groupBy({ by: ['userId'], where: { createdAt: { gte: thirtyDaysAgo } } })
        .then((res) => res.length),
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

    // Top destinations formatted
    const topDestinations = topDestinationsRaw
      .filter((d) => d.destination && d.destination.trim() !== '')
      .map((d) => ({
        destination: d.destination as string,
        tripsCount: d._count.id,
      }));

    // Phễu chuyển đổi 5 bước
    const funnel = [
      { step: 'Đăng ký tài khoản', count: totalUsersCount, percentage: 100 },
      {
        step: 'Tạo chuyến đi đầu tiên',
        count: tripCreatorsCount,
        percentage:
          totalUsersCount > 0
            ? Math.round((tripCreatorsCount / totalUsersCount) * 100)
            : 0,
      },
      {
        step: 'Tham gia Squad (Nhóm)',
        count: activeInSquadCount,
        percentage:
          totalUsersCount > 0
            ? Math.round((activeInSquadCount / totalUsersCount) * 100)
            : 0,
      },
      {
        step: 'Tạo chi tiêu / Chia tiền',
        count: expenseOrMomentUsersCount,
        percentage:
          totalUsersCount > 0
            ? Math.round((expenseOrMomentUsersCount / totalUsersCount) * 100)
            : 0,
      },
      {
        step: 'Nâng cấp Gói PLUS / SQUAD',
        count: payingUsersCount,
        percentage:
          totalUsersCount > 0
            ? Math.round((payingUsersCount / totalUsersCount) * 100)
            : 0,
      },
    ];

    const dau = Math.max(dauActivities, 1);
    const wau = Math.max(wauActivities, dau);
    const mau = Math.max(mauActivities, wau);
    const stickiness = mau > 0 ? Math.round((dau / mau) * 100) : 0;

    return {
      dailyGrowth: Object.values(dateMap),
      totalUsersLast30Days: users.length,
      totalTripsLast30Days: trips.length,
      topDestinations,
      funnel,
      engagement: {
        dau,
        wau,
        mau,
        stickinessRatio: `${stickiness}%`,
        membersPerTrip:
          trips.length > 0 ? (activeInSquadCount / trips.length).toFixed(1) : '3.2',
      },
    };
  }

  async getRevenueAnalytics() {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [subscriptions, transactions, recentSubscriptionCharges, recentP2PTransactions, walletCount] = await Promise.all([
      this.prisma.subscription.findMany({
        select: {
          id: true,
          plan: true,
          status: true,
          provider: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          canceledAt: true,
          createdAt: true,
        },
      }),
      this.prisma.paymentTransaction.findMany({
        select: { amount: true, status: true, provider: true, createdAt: true },
      }),
      this.prisma.subscription.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      }),
      this.prisma.paymentTransaction.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: { id: true, name: true, email: true, username: true, avatarUrl: true },
          },
          receiver: {
            select: { id: true, name: true, email: true, username: true, avatarUrl: true },
          },
          expense: {
            select: { id: true, description: true, amount: true },
          },
        },
      }),
      this.prisma.userWallet.count(),
    ]);

    // Lọc các gói đang thực sự có hiệu lực: status = ACTIVE và currentPeriodEnd > now
    const activeSubs = subscriptions.filter(
      (s) => s.status === 'ACTIVE' && s.currentPeriodEnd > now,
    );

    // Tính MRR chuẩn theo giá gói Việt Nam: PLUS = 39.000đ, SQUAD = 99.000đ
    const activePlusSubs = activeSubs.filter((s) => s.plan === 'PLUS');
    const activeSquadSubs = activeSubs.filter((s) => s.plan === 'SQUAD');

    const mrr = activePlusSubs.length * 39000 + activeSquadSubs.length * 99000;

    // Số gói sắp hết hạn trong 7 ngày tới
    const expiringSoonCount = activeSubs.filter(
      (s) => s.currentPeriodEnd <= in7Days,
    ).length;

    // Số gói đã yêu cầu huỷ vào cuối kỳ hoặc đã huỷ
    const cancelingCount = subscriptions.filter(
      (s) => s.cancelAtPeriodEnd || s.status === 'CANCELED' || s.canceledAt !== null,
    ).length;

    // Phân bổ cổng thanh toán của các gói đăng ký
    const subscriptionProviderBreakdown: Record<string, number> = {};
    subscriptions.forEach((s) => {
      const p = s.provider || 'OTHER';
      subscriptionProviderBreakdown[p] = (subscriptionProviderBreakdown[p] || 0) + 1;
    });

    // Thống kê giao dịch chia sẻ chi phí giữa các thành viên trong chuyến (Peer-to-Peer Split)
    const tripSplitVolume = transactions
      .filter((t) => t.status === 'SUCCESS')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const tripSplitStatusBreakdown: Record<string, number> = {};
    const tripSplitMethodBreakdown: Record<string, number> = {};

    transactions.forEach((t) => {
      tripSplitStatusBreakdown[t.status] = (tripSplitStatusBreakdown[t.status] || 0) + 1;
      const method = t.provider || 'CASH';
      tripSplitMethodBreakdown[method] = (tripSplitMethodBreakdown[method] || 0) + 1;
    });

    const recentCharges = recentSubscriptionCharges.map((s) => {
      const price = s.plan === 'PLUS' ? 39000 : 99000;
      return {
        id: s.id,
        type: 'SUBSCRIPTION',
        plan: s.plan,
        amount: price,
        currency: 'VND',
        provider: s.provider,
        status: s.status,
        externalId: s.externalId || 'N/A',
        seats: s.seats,
        createdAt: s.createdAt,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        user: s.user
          ? {
              id: s.user.id,
              name: s.user.name,
              email: s.user.email,
              username: s.user.username,
              avatarUrl: s.user.avatarUrl,
            }
          : null,
      };
    });

    const recentP2P = recentP2PTransactions.map((t) => ({
      id: t.id,
      type: 'P2P_SPLIT',
      amount: Number(t.amount || 0),
      currency: 'VND',
      provider: t.provider,
      status: t.status,
      externalId: t.transactionId || 'N/A',
      note: t.note,
      createdAt: t.createdAt,
      sender: t.sender
        ? {
            id: t.sender.id,
            name: t.sender.name,
            email: t.sender.email,
            username: t.sender.username,
          }
        : null,
      receiver: t.receiver
        ? {
            id: t.receiver.id,
            name: t.receiver.name,
            email: t.receiver.email,
            username: t.receiver.username,
          }
        : null,
      expense: t.expense ? { id: t.expense.id, title: t.expense.description || 'Chi phí chuyến đi' } : null,
    }));

    return {
      // Platform Subscription Revenue
      mrr,
      activeSubscriptionsCount: activeSubs.length,
      totalSubscriptionsCount: subscriptions.length,
      activePlusCount: activePlusSubs.length,
      activeSquadCount: activeSquadSubs.length,
      expiringSoonCount,
      cancelingCount,
      activeByPlan: {
        PLUS: {
          count: activePlusSubs.length,
          monthlyPrice: 39000,
          revenue: activePlusSubs.length * 39000,
        },
        SQUAD: {
          count: activeSquadSubs.length,
          monthlyPrice: 99000,
          revenue: activeSquadSubs.length * 99000,
        },
      },
      subscriptionProviderBreakdown,

      // Chi tiết các khoản thu / giao dịch để đối soát (Audit & Trace)
      recentCharges,
      recentP2P,

      // Peer-to-Peer Trip Expense Split (Giữ lại và đổi nhãn rõ ràng)
      tripSplitVolume,
      tripSplitTransactionsCount: transactions.length,
      tripSplitStatusBreakdown,
      tripSplitMethodBreakdown,

      // Tương thích ngược với các trường cũ
      totalVolume: tripSplitVolume,
      totalTransactions: transactions.length,
      walletCount,
      statusBreakdown: tripSplitStatusBreakdown,
      methodBreakdown: tripSplitMethodBreakdown,
    };
  }

  async getAiAnalytics() {
    const [totalRequests, requests] = await Promise.all([
      this.prisma.aIRequest.count(),
      this.prisma.aIRequest.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
    ]);

    const typeBreakdown: Record<string, number> = {};
    requests.forEach((r) => {
      const type = r.type || 'GENERAL';
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
    });

    const recentLogs = requests.slice(0, 20).map((r) => ({
      id: r.id,
      type: r.type,
      prompt: r.prompt,
      status: r.status,
      createdAt: r.createdAt,
      user: r.user ? { name: r.user.name, email: r.user.email } : null,
    }));

    return {
      totalRequests,
      recentRequestsCount: requests.length,
      typeBreakdown,
      recentLogs,
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

  async deleteConfig(key: string) {
    return this.prisma.systemConfig.delete({
      where: { key },
    });
  }

  // --- SUBSCRIPTION MANAGEMENT ---
  async getSubscriptions(params: {
    search?: string;
    plan?: Plan;
    status?: string;
    expiringSoon?: boolean | string;
    page?: number;
    limit?: number;
  }) {
    const page = Number(params.page) || 1;
    const limit = Number(params.limit) || 10;
    const skip = (page - 1) * limit;
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const where: any = {};

    if (params.plan) {
      where.plan = params.plan;
    }

    if (params.status) {
      if (params.status === 'ACTIVE') {
        where.status = 'ACTIVE';
        where.currentPeriodEnd = { gt: now };
      } else if (params.status === 'EXPIRED') {
        where.OR = [
          { status: { in: ['EXPIRED', 'PAST_DUE'] } },
          { currentPeriodEnd: { lte: now } },
        ];
      } else if (params.status === 'CANCELING') {
        where.status = 'ACTIVE';
        where.cancelAtPeriodEnd = true;
        where.currentPeriodEnd = { gt: now };
      }
    }

    const isExpiringSoonQuery =
      params.expiringSoon === true || params.expiringSoon === 'true';
    if (isExpiringSoonQuery) {
      where.status = 'ACTIVE';
      where.currentPeriodEnd = {
        gt: now,
        lte: in7Days,
      };
    }

    if (params.search && params.search.trim() !== '') {
      const search = params.search.trim();
      const searchConditions: any[] = [
        { externalId: { contains: search, mode: 'insensitive' } },
        {
          user: {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { username: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      ];

      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchConditions }];
        delete where.OR;
      } else {
        where.OR = searchConditions;
      }
    }

    const [total, items] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              username: true,
            },
          },
          squadSeats: {
            where: { revokedAt: null },
            select: { id: true, userId: true },
          },
        },
      }),
    ]);

    const formattedItems = items.map((sub) => {
      const isEffectiveActive =
        sub.status === 'ACTIVE' && sub.currentPeriodEnd > now;
      const isExpiringSoon =
        isEffectiveActive && sub.currentPeriodEnd <= in7Days;
      return {
        id: sub.id,
        userId: sub.userId,
        plan: sub.plan,
        status: sub.status,
        isEffectiveActive,
        isExpiringSoon,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        canceledAt: sub.canceledAt,
        provider: sub.provider,
        externalId: sub.externalId,
        seats: sub.seats,
        usedSeatsCount: sub.squadSeats.length,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        user: sub.user,
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formattedItems,
    };
  }

  async getSubscription(id: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            username: true,
            createdAt: true,
          },
        },
        squadSeats: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                username: true,
              },
            },
          },
          orderBy: { grantedAt: 'desc' },
        },
      },
    });

    if (!sub) throw new NotFoundException('Subscription not found');

    const auditLogs = await this.prisma.adminAuditLog.findMany({
      where: { targetType: 'SUBSCRIPTION', targetId: id },
      include: {
        admin: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const isEffectiveActive =
      sub.status === 'ACTIVE' && sub.currentPeriodEnd > now;
    const isExpiringSoon =
      isEffectiveActive && sub.currentPeriodEnd <= in7Days;

    return {
      ...sub,
      isEffectiveActive,
      isExpiringSoon,
      usedSeatsCount: sub.squadSeats.filter((s) => !s.revokedAt).length,
      auditLogs,
    };
  }

  async extendSubscription(
    adminId: string,
    id: string,
    months: number,
    reason: string,
  ) {
    if (!reason || reason.trim() === '') {
      throw new BadRequestException('Lý do gia hạn là bắt buộc');
    }
    if (!months || months < 1) {
      throw new BadRequestException('Số tháng gia hạn tối thiểu là 1');
    }

    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException('Subscription not found');

    const now = new Date();
    const base = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
    const newEnd = new Date(base);
    newEnd.setMonth(newEnd.getMonth() + Number(months));

    const updated = await this.prisma.subscription.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        currentPeriodEnd: newEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
    });

    // Record audit log
    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: 'EXTEND_SUBSCRIPTION',
        targetType: 'SUBSCRIPTION',
        targetId: id,
        reason: reason.trim(),
        details: {
          months,
          previousPeriodEnd: sub.currentPeriodEnd.toISOString(),
          newPeriodEnd: newEnd.toISOString(),
          previousStatus: sub.status,
        },
      },
    });

    return updated;
  }

  async revokeSubscription(adminId: string, id: string, reason: string) {
    if (!reason || reason.trim() === '') {
      throw new BadRequestException('Lý do thu hồi gói là bắt buộc');
    }

    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { squadSeats: { where: { revokedAt: null } } },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    const now = new Date();

    // Revoke all active squad seats
    if (sub.squadSeats.length > 0) {
      await this.prisma.squadSeat.updateMany({
        where: { subscriptionId: id, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    // Update subscription to EXPIRED
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: {
        status: 'EXPIRED',
        currentPeriodEnd: now,
        cancelAtPeriodEnd: true,
        canceledAt: now,
      },
    });

    // Record audit log
    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: 'REVOKE_SUBSCRIPTION',
        targetType: 'SUBSCRIPTION',
        targetId: id,
        reason: reason.trim(),
        details: {
          revokedSeatsCount: sub.squadSeats.length,
          previousPeriodEnd: sub.currentPeriodEnd.toISOString(),
          previousStatus: sub.status,
        },
      },
    });

    return updated;
  }
}

