import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { I18nContext } from 'nestjs-i18n';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // Mock databases
  private userBadges: Record<string, any[]> = {};
  private socialLinks: Record<string, any> = {};
  private userFollowers: Record<string, string[]> = {};

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      include: {
        presence: true,
        _count: { select: { tripMembers: true, moments: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Xoá tài khoản (PDPD / quyền được xoá dữ liệu).
   * Soft-delete: đặt deletedAt + ẩn danh email/username để giải phóng unique
   * constraint, người dùng không thể đăng nhập lại bằng tài khoản này.
   */
  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found');

    const stamp = Date.now();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        email: `deleted_${stamp}_${user.email}`,
        username: user.username ? `deleted_${stamp}_${user.username}` : null,
      },
    });
    return { success: true, message: 'Tài khoản đã được xoá.' };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        username: dto.username,
        bio: dto.bio,
        avatarUrl: dto.avatarUrl,
        vibeTags: dto.vibeTags,
        theme: dto.theme,
      },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        bio: true,
        avatarUrl: true,
        vibeTags: true,
        theme: true,
        travelScore: true,
        chaosScore: true,
        updatedAt: true,
      },
    });
  }

  async updatePresence(
    userId: string,
    data: {
      status?: any;
      currentTripId?: string | null;
      latitude?: number;
      longitude?: number;
    },
  ) {
    return this.prisma.userPresence.upsert({
      where: { userId },
      create: {
        userId,
        status: data.status ?? 'ONLINE',
        currentTripId: data.currentTripId,
        latitude: data.latitude,
        longitude: data.longitude,
        lastSeen: new Date(),
      },
      update: {
        status: data.status,
        currentTripId: data.currentTripId,
        latitude: data.latitude,
        longitude: data.longitude,
        lastSeen: new Date(),
      },
    });
  }

  async getMyTrips(userId: string) {
    const trips = await this.prisma.trip.findMany({
      where: { members: { some: { userId } }, deletedAt: null },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
              },
            },
          },
        },
        _count: { select: { members: true, moments: true, expenses: true } },
      },
      orderBy: { startDate: 'asc' },
    });

    // Trước đây: nếu user chưa có chuyến nào thì BE tự dựng một chuyến demo
    // (kèm vài tài khoản user giả, lịch trình giả, chi tiêu + chia tiền giả)
    // và GHI THẲNG vào database thật. Hậu quả:
    //   - Người dùng mới mở app thấy một chuyến lạ với những người lạ.
    //   - Empty state thật của app không bao giờ hiển thị được.
    //   - DB production bị rác: user @tripmate.local, trip/expense giả.
    // Đã bỏ. Danh sách rỗng là trạng thái hợp lệ và app đã có empty state tử tế
    // cho nó (my_trips_screen_test.dart phủ đúng trường hợp này).

    return trips;
  }

  // --- MODULE 9 (PROFILE / IDENTITY FLOW) EXTENSIONS ---

  /// Huy hiệu của người dùng.
  ///
  /// Định nghĩa huy hiệu là catalog tĩnh (hợp lý), nhưng trạng thái mở khoá
  /// PHẢI tính từ dữ liệu thật. Trước đây b1/b2 luôn trả `unlockedAt: new Date()`
  /// nên mọi tài khoản mới tinh đều thấy mình đã đạt "Siêu Cấp Phượt Thủ".
  async getBadges(userId: string) {
    const i18n = I18nContext.current();
    const t = (key: string, fallback: string) =>
      i18n ? i18n.t(`common.badges.${key}`) : fallback;

    const [tripCount, checkinCount, expensePaidCount] = await Promise.all([
      this.prisma.tripMember.count({ where: { userId } }),
      this.prisma.dayCheckin.count({ where: { userId, status: 'GOING' } }),
      this.prisma.expense.count({ where: { paidById: userId } }),
    ]);

    const badges = [
      {
        id: 'b1',
        title: t('b1_title', 'Siêu Cấp Phượt Thủ 🏆'),
        desc: t('b1_desc', 'Đi trên 5 chuyến đi cùng TripMate'),
        progress: { current: tripCount, target: 5 },
        unlocked: tripCount >= 5,
      },
      {
        id: 'b2',
        title: t('b2_title', 'Thần Tài Gõ Đầu 💸'),
        desc: t('b2_desc', 'Đứng ra trả trước từ 3 khoản chi của nhóm'),
        progress: { current: expensePaidCount, target: 3 },
        unlocked: expensePaidCount >= 3,
      },
      {
        id: 'b3',
        title: t('b3_title', 'Thợ Săn Check-in 📍'),
        desc: t('b3_desc', 'Check-in xác nhận tham gia 10 ngày hoạt động'),
        progress: { current: checkinCount, target: 10 },
        unlocked: checkinCount >= 10,
      },
    ];

    // Giữ nguyên khoá `unlockedAt` để client cũ không vỡ; null = chưa đạt.
    return badges.map((b) => ({
      ...b,
      unlockedAt: b.unlocked ? new Date() : null,
    }));
  }

  async getFollowers(userId: string) {
    if (!this.userFollowers[userId]) {
      this.userFollowers[userId] = ['Alex Nguyễn', 'Trần Bình', 'Lê Minh'];
    }
    return {
      followers: this.userFollowers[userId],
      followersCount: this.userFollowers[userId].length,
      followingCount: 15,
    };
  }

  async getSocialLinks(userId: string) {
    // Mặc định rỗng cho user mới (không gán social giả của người khác).
    if (!this.socialLinks[userId]) {
      this.socialLinks[userId] = {
        facebook: null,
        instagram: null,
        tiktok: null,
      };
    }
    return this.socialLinks[userId];
  }

  async updateSocialLinks(userId: string, data: any) {
    const current = await this.getSocialLinks(userId);
    this.socialLinks[userId] = {
      ...current,
      facebook: data.facebook ?? current.facebook,
      instagram: data.instagram ?? current.instagram,
      tiktok: data.tiktok ?? current.tiktok,
    };
    return this.socialLinks[userId];
  }

  async getProfileStats(userId: string) {
    // Số liệu THẬT từ DB — không hardcode để user mới không thấy stats giả.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { travelScore: true, chaosScore: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const totalTrips = await this.prisma.tripMember.count({
      where: { userId },
    });

    return {
      userId,
      totalTrips,
      // Chưa có nguồn quãng đường thật → 0 (thay vì số giả 4200km).
      totalDistanceKm: 0,
      achievementPoints: user.travelScore,
      // Rep suy từ travelScore thật (0 → "New", >=90 → "Legendary").
      squadReputationScore: Math.min(100, user.travelScore),
      chaosScore: user.chaosScore,
    };
  }

  /**
   * Dữ liệu THẬT cho màn Travel Atlas: số chuyến, số địa điểm, streak tháng,
   * và các marker (từ itinerary có toạ độ + moment có GPS).
   */
  /// Tổng hợp chi tiêu trên mọi chuyến của user — nguồn cho khối "The Roast".
  ///
  /// Trước đây khối này hiển thị cứng "TỔNG: 500K", "80% PAID" và một câu
  /// roast bịa tên người. Nay tính từ `expense_splits` thật; không có khoản
  /// chi nào thì `hasData: false` để client ẩn khối đi.
  async getExpenseSummary(userId: string) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    const empty = {
      hasData: false,
      totalAmount: 0,
      paidCount: 0,
      totalCount: 0,
      paidPercent: 0,
      topDebtorName: null as string | null,
      topDebtorAmount: 0,
    };
    if (tripIds.length === 0) return empty;

    const splits = await this.prisma.expenseSplit.findMany({
      where: { expense: { tripId: { in: tripIds } } },
      include: {
        user: { select: { id: true, name: true } },
        expense: { select: { amount: true } },
      },
    });
    if (splits.length === 0) return empty;

    const totalAmount = splits.reduce(
      (sum, s) => sum + Number(s.shareAmount),
      0,
    );
    const paidCount = splits.filter((s) => s.isPaid).length;

    // Ai đang nợ nhiều nhất (tổng phần chưa trả).
    const debtByUser = new Map<string, { name: string; amount: number }>();
    for (const s of splits) {
      if (s.isPaid) continue;
      const cur = debtByUser.get(s.userId) ?? { name: s.user.name, amount: 0 };
      cur.amount += Number(s.shareAmount);
      debtByUser.set(s.userId, cur);
    }
    let top: { name: string; amount: number } | null = null;
    for (const entry of debtByUser.values()) {
      if (!top || entry.amount > top.amount) top = entry;
    }

    return {
      hasData: true,
      totalAmount,
      paidCount,
      totalCount: splits.length,
      paidPercent: Math.round((paidCount / splits.length) * 100),
      topDebtorName: top?.name ?? null,
      topDebtorAmount: top?.amount ?? 0,
    };
  }

  /// Hoạt động mới nhất trên mọi chuyến của user — nguồn cho marquee màn Home.
  ///
  /// Trước đây marquee chạy một mảng câu cứng ("Phú Khang owes 420k"...) nên
  /// tài khoản nào cũng thấy y hệt nhau.
  async getRecentActivities(userId: string, limit = 12) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) return [];

    const rows = await this.prisma.activity.findMany({
      where: { tripId: { in: tripIds } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true } },
        trip: { select: { id: true, name: true } },
      },
    });

    return rows.map((a) => ({
      id: a.id,
      type: a.type,
      tripId: a.tripId,
      tripName: a.trip.name,
      actorName: a.user.name,
      data: a.data,
      createdAt: a.createdAt,
    }));
  }

  /// Điểm lịch trình kế tiếp của user — nguồn cho thẻ "Up Next" màn Home.
  ///
  /// Lấy chuyến gần nhất chưa kết thúc, rồi điểm đầu tiên của ngày hiện tại
  /// (hoặc ngày 1 nếu chuyến chưa bắt đầu). Trả `null` khi không có gì —
  /// client ẩn thẻ thay vì bịa "Night Market Chaos".
  async getUpNext(userId: string) {
    const now = new Date();
    const membership = await this.prisma.tripMember.findFirst({
      where: {
        userId,
        trip: { deletedAt: null, endDate: { gte: now } },
      },
      orderBy: { trip: { startDate: 'asc' } },
      select: { trip: { select: { id: true, name: true, startDate: true } } },
    });
    if (!membership?.trip) return null;

    const trip = membership.trip;
    // Ngày thứ mấy của chuyến (1-based); chuyến chưa bắt đầu → ngày 1.
    const msPerDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor(
      (now.getTime() - trip.startDate.getTime()) / msPerDay,
    );
    const currentDay = diffDays < 0 ? 1 : diffDays + 1;

    const item = await this.prisma.itineraryItem.findFirst({
      where: { tripId: trip.id, day: { gte: currentDay } },
      orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
    });
    if (!item) return null;

    return {
      tripId: trip.id,
      tripName: trip.name,
      day: item.day,
      startTime: item.startTime,
      placeName: item.placeName,
      placeAddress: item.placeAddress,
      category: item.category,
      durationMinutes: item.durationMinutes,
    };
  }

  /// Kỷ niệm mới nhất trên tất cả chuyến mà user là thành viên.
  ///
  /// Dùng cho khối "scrapbook" ở màn Home — trước đây khối này hiển thị 2 tấm
  /// polaroid cứng (ảnh Unsplash, tên người bịa) cho mọi tài khoản.
  async getRecentMoments(userId: string, limit = 6) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) return [];

    const moments = await this.prisma.moment.findMany({
      where: { tripId: { in: tripIds }, deletedAt: null, isGhost: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        trip: { select: { id: true, name: true, destination: true } },
      },
    });

    return moments.map((m) => ({
      id: m.id,
      tripId: m.tripId,
      tripName: m.trip.name,
      mediaUrl: m.mediaUrl,
      caption: m.caption,
      authorName: m.user.name,
      authorAvatarUrl: m.user.avatarUrl,
      location: m.trip.destination ?? m.trip.name,
      createdAt: m.createdAt,
    }));
  }

  async getTravelAtlas(userId: string) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) {
      const empty = {
        totalTrips: 0,
        placesExplored: 0,
        checkIns: 0,
        streakMonths: 0,
      };
      // Vẫn trả `badges` (tất cả đều khoá) thay vì bỏ trống: client coi mảng
      // rỗng là "chưa tải xong" và rơi về danh sách huy hiệu mock.
      return { ...empty, markers: [], badges: this.computeBadges(empty) };
    }

    const [itineraries, moments, trips] = await Promise.all([
      this.prisma.itineraryItem.findMany({
        where: { tripId: { in: tripIds } },
        select: {
          placeName: true,
          latitude: true,
          longitude: true,
        },
      }),
      this.prisma.moment.findMany({
        where: {
          tripId: { in: tripIds },
          latitude: { not: null },
          longitude: { not: null },
          deletedAt: null,
        },
        select: {
          latitude: true,
          longitude: true,
          caption: true,
          trip: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.trip.findMany({
        where: { id: { in: tripIds } },
        select: { startDate: true },
      }),
    ]);

    // Số địa điểm distinct từ tên trong itinerary.
    const placeNames = new Set(
      itineraries
        .map((i) => i.placeName?.trim().toLowerCase())
        .filter((n): n is string => !!n),
    );

    // Marker có tên (itinerary có toạ độ) + check-in (moment có GPS).
    const markers: Array<{
      lat: number;
      lng: number;
      name: string;
      type: 'PLACE' | 'CHECKIN';
    }> = [];
    for (const it of itineraries) {
      if (it.latitude != null && it.longitude != null) {
        markers.push({
          lat: Number(it.latitude),
          lng: Number(it.longitude),
          name: it.placeName,
          type: 'PLACE',
        });
      }
    }
    for (const m of moments) {
      markers.push({
        lat: Number(m.latitude),
        lng: Number(m.longitude),
        name: m.caption?.trim() || m.trip.name,
        type: 'CHECKIN',
      });
    }

    const streakMonths = this.computeMonthStreak(trips.map((t) => t.startDate));
    const stats = {
      totalTrips: tripIds.length,
      placesExplored: placeNames.size,
      checkIns: moments.length,
      streakMonths,
    };

    return {
      ...stats,
      markers,
      badges: this.computeBadges(stats),
    };
  }

  /** Huy hiệu tính động từ số liệu THẬT (không cần bảng riêng). */
  private computeBadges(stats: {
    totalTrips: number;
    placesExplored: number;
    checkIns: number;
    streakMonths: number;
  }) {
    const defs: Array<{
      title: string;
      description: string;
      current: number;
      target: number;
    }> = [
      {
        title: 'Người Mới Khởi Hành 🎒',
        description: 'Tham gia chuyến đi đầu tiên.',
        current: stats.totalTrips,
        target: 1,
      },
      {
        title: 'Phượt Thủ Chính Hiệu 🏍️',
        description: 'Góp mặt trong 5 chuyến đi.',
        current: stats.totalTrips,
        target: 5,
      },
      {
        title: 'Nhà Sưu Tầm Địa Điểm 📍',
        description: 'Khám phá 10 địa điểm khác nhau.',
        current: stats.placesExplored,
        target: 10,
      },
      {
        title: 'Tay Máy Du Ký 📸',
        description: 'Check-in 5 khoảnh khắc có vị trí.',
        current: stats.checkIns,
        target: 5,
      },
      {
        title: 'Ngọn Lửa Bất Diệt 🔥',
        description: 'Giữ streak 3 tháng liên tục.',
        current: stats.streakMonths,
        target: 3,
      },
      {
        title: 'Huyền Thoại Xê Dịch 🌍',
        description: 'Hoàn thành 10 chuyến đi.',
        current: stats.totalTrips,
        target: 10,
      },
    ];
    return defs.map((d) => ({
      title: d.title,
      description: d.description,
      isUnlocked: d.current >= d.target,
      progress: Math.min(1, d.target === 0 ? 1 : d.current / d.target),
    }));
  }

  /**
   * Những người đã đi chung chuyến với tôi — "bạn bè" theo nghĩa thật của app.
   *
   * App không có tính năng kết bạn riêng, nên màn Danh sách bạn bè trước đây
   * hiển thị 3 người bịa. Nguồn thật duy nhất là đồng đội trong các chuyến:
   * gộp theo user, đếm số chuyến chung và giữ chuyến gần nhất.
   */
  async getTravelBuddies(userId: string) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId, trip: { deletedAt: null } },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) return [];

    const others = await this.prisma.tripMember.findMany({
      where: { tripId: { in: tripIds }, userId: { not: userId } },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        trip: { select: { id: true, name: true, startDate: true } },
      },
    });

    const byUser = new Map<
      string,
      {
        id: string;
        name: string;
        avatarUrl: string | null;
        sharedTrips: number;
        lastTripName: string;
        lastTripAt: Date | null;
      }
    >();
    for (const m of others) {
      if (!m.user) continue;
      const cur = byUser.get(m.user.id);
      const startedAt = m.trip?.startDate ?? null;
      if (!cur) {
        byUser.set(m.user.id, {
          id: m.user.id,
          name: m.user.name,
          avatarUrl: m.user.avatarUrl,
          sharedTrips: 1,
          lastTripName: m.trip?.name ?? '',
          lastTripAt: startedAt,
        });
        continue;
      }
      cur.sharedTrips++;
      // Giữ chuyến mới nhất để hiển thị dòng phụ.
      if (startedAt && (!cur.lastTripAt || startedAt > cur.lastTripAt)) {
        cur.lastTripAt = startedAt;
        cur.lastTripName = m.trip?.name ?? cur.lastTripName;
      }
    }

    return [...byUser.values()].sort((a, b) => b.sharedTrips - a.sharedTrips);
  }

  /** Số tháng liên tiếp (tính tới tháng hiện tại) có ít nhất 1 chuyến. */
  private computeMonthStreak(dates: Date[]): number {
    if (dates.length === 0) return 0;
    const months = new Set(
      dates.map((d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`),
    );
    let streak = 0;
    const cursor = new Date();
    // Đi ngược từ tháng hiện tại, dừng khi gặp tháng trống.
    for (;;) {
      const key = `${cursor.getUTCFullYear()}-${cursor.getUTCMonth()}`;
      if (!months.has(key)) break;
      streak++;
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    return streak;
  }
}
