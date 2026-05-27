import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

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
    return this.prisma.trip.findMany({
      where: { members: { some: { userId } }, deletedAt: null },
      include: {
        _count: { select: { members: true, moments: true, expenses: true } },
      },
      orderBy: { startDate: 'asc' },
    });
  }

  // --- MODULE 9 (PROFILE / IDENTITY FLOW) EXTENSIONS ---

  async getBadges(userId: string) {
    if (!this.userBadges[userId]) {
      this.userBadges[userId] = [
        { id: 'b1', title: 'Siêu Cấp Phượt Thủ 🏆', desc: 'Đi trên 5 chuyến đi cùng TripMate', unlockedAt: new Date() },
        { id: 'b2', title: 'Thần Tài Gõ Đầu 💸', desc: 'Bị chọn thanh toán wheel splitter game', unlockedAt: new Date() },
        { id: 'b3', title: 'Thần Gió Nhật Bản 🚄', desc: 'Có checkin Shinkansen', unlockedAt: null },
      ];
    }
    return this.userBadges[userId];
  }

  async getThemeMarketplace() {
    return [
      { id: 'theme-1', name: 'Kyoto Neon Vaporwave 🌌', priceXP: 500, previewUrl: 'assets/themes/kyoto.jpg' },
      { id: 'theme-2', name: 'Dalat Pine Minimalist 🌲', priceXP: 300, previewUrl: 'assets/themes/dalat.jpg' },
      { id: 'theme-3', name: 'Cyberpunk Chaos ⚡', priceXP: 1000, previewUrl: 'assets/themes/cyber.jpg' },
    ];
  }

  async getStickerStore() {
    return [
      { id: 'stk-1', label: 'Cười ra nước mắt 😂', costXP: 100, assetUrl: 'assets/stickers/laugh.png' },
      { id: 'stk-2', label: 'Cà khịa hết nấc 😜', costXP: 200, assetUrl: 'assets/stickers/roast.png' },
      { id: 'stk-3', label: 'Mệt mỏi vì tiền 💸', costXP: 150, assetUrl: 'assets/stickers/poor.png' },
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

    const current = this.stickerInventory[userId].find((s) => s.id === stickerId);
    if (current) {
      current.count += 1;
    } else {
      this.stickerInventory[userId].push({ id: stickerId, label: item.label, count: 1 });
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
    if (!this.socialLinks[userId]) {
      this.socialLinks[userId] = {
        facebook: 'https://facebook.com/minhnhatchaos',
        instagram: 'https://instagram.com/minhnhat.travel',
        tiktok: 'https://tiktok.com/@minhnhat.phuot',
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
    return {
      userId,
      totalTrips: 12,
      totalDistanceKm: 4200.5,
      achievementPoints: 1250,
      squadReputationScore: 98, // Rep level: extremely reliable squad mate
      chaosScore: 42,
    };
  }
}
