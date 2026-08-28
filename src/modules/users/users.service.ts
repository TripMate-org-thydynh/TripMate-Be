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
  private stickerInventory: Record<string, any[]> = {};
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
    return badges.map((b) => ({ ...b, unlockedAt: b.unlocked ? new Date() : null }));
  }

  async getThemeMarketplace() {
    const i18n = I18nContext.current();
    return [
      {
        id: 'theme-1',
        name: i18n ? i18n.t('common.themes.theme1') : 'Kyoto Neon Vaporwave 🌌',
        priceXP: 500,
        previewUrl: 'assets/themes/kyoto.jpg',
      },
      {
        id: 'theme-2',
        name: i18n
          ? i18n.t('common.themes.theme2')
          : 'Dalat Pine Minimalist 🌲',
        priceXP: 300,
        previewUrl: 'assets/themes/dalat.jpg',
      },
      {
        id: 'theme-3',
        name: i18n ? i18n.t('common.themes.theme3') : 'Cyberpunk Chaos ⚡',
        priceXP: 1000,
        previewUrl: 'assets/themes/cyber.jpg',
      },
    ];
  }

  async getStickerStore() {
    return [
      {
        id: 'stk-1',
        label: 'Cười ra nước mắt 😂',
        costXP: 100,
        assetUrl: 'assets/stickers/laugh.png',
      },
      {
        id: 'stk-2',
        label: 'Cà khịa hết nấc 😜',
        costXP: 200,
        assetUrl: 'assets/stickers/roast.png',
      },
      {
        id: 'stk-3',
        label: 'Mệt mỏi vì tiền 💸',
        costXP: 150,
        assetUrl: 'assets/stickers/poor.png',
      },
      {
        id: 'stk-4',
        label: 'Đang bay lắc 🚀',
        costXP: 180,
        assetUrl: 'assets/stickers/party.png',
      },
    ];
  }

  async getStickersInventory(userId: string) {
    if (!this.stickerInventory[userId]) {
      this.stickerInventory[userId] = [
        { id: 'stk-1', label: 'Cười ra nước mắt 😂', count: 5 },
      ];
    }
    return this.stickerInventory[userId];
  }

  async purchaseSticker(userId: string, stickerId: string) {
    const store = await this.getStickerStore();
    const item = store.find((s) => s.id === stickerId);
    if (!item) throw new NotFoundException('Sticker not found in store');

    if (!this.stickerInventory[userId]) {
      this.stickerInventory[userId] = [];
    }

    const current = this.stickerInventory[userId].find(
      (s) => s.id === stickerId,
    );
    if (current) {
      current.count += 1;
    } else {
      this.stickerInventory[userId].push({
        id: stickerId,
        label: item.label,
        count: 1,
      });
    }
    return { success: true, inventory: this.stickerInventory[userId] };
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
