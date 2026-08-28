import { Injectable, NotFoundException } from '@nestjs/common';
import { GameType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class GamesService {
  constructor(private prisma: PrismaService) {}

  private squadXP: Record<string, any> = {};
  private seasonalMissions: any[] = [
    {
      id: 'season-1',
      title: 'Kyoto Matsuri Vibe 🌸',
      desc: 'Chụp hình với Kimono và up Scrapbook',
      rewardXP: 1000,
      deadline: '2026-06-30',
    },
  ];
  private weeklyMissions: any[] = [
    {
      id: 'week-1',
      title: 'Kẻ Bắn Tỉa Ghost Cam 📸',
      desc: 'Săn 3 bức hình dìm hàng của đồng đội bằng Ghost Cam',
      rewardXP: 400,
    },
    {
      id: 'week-2',
      title: 'Vua Tiết Kiệm 💸',
      desc: 'Tổng chi tiêu tuần dưới hạn mức 80%',
      rewardXP: 300,
    },
  ];

  async create(tripId: string, gameType: GameType, initialState: object) {
    return this.prisma.gameSession.create({
      data: { tripId, gameType, stateJson: initialState, isActive: true },
    });
  }

  async findAll(tripId: string) {
    return this.prisma.gameSession.findMany({
      where: { tripId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.gameSession.findUnique({ where: { id } });
  }

  async updateState(id: string, stateJson: object) {
    return this.prisma.gameSession.update({
      where: { id },
      data: { stateJson },
    });
  }

  async endSession(id: string) {
    return this.prisma.gameSession.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // --- MODULE 8 (GAME FLOW) EXTENSIONS ---

  async getRandomDare() {
    const dares = [
      'Uống hết ly nước này trong 5 giây! 🍺',
      'Hát một bài hát thiếu nhi bằng giọng em bé! 🎤',
      'Chụp ảnh dìm hàng Lê Minh và post lên Realtime Feed! 📸',
      'Nắm tay Alex Nguyễn trong vòng 1 phút! 🤝',
      'Để cả nhóm vẽ bậy lên mặt bằng son! 💄',
    ];
    const randomIndex = Math.floor(Math.random() * dares.length);
    return {
      dareText: dares[randomIndex],
      xpReward: 150,
      chaosFactor: 'Extreme 🔥',
    };
  }

  async getXpProgression(tripId: string) {
    if (!this.squadXP[tripId]) {
      this.squadXP[tripId] = {
        tripId,
        squadLevel: 4,
        currentXP: 1420,
        nextLevelXP: 2500,
        unlockedPerks: ['Voucher Kyoto Ryokan 10%', 'Theme App Độc Quyền'],
      };
    }
    return this.squadXP[tripId];
  }

  async getSeasonalEvents() {
    return this.seasonalMissions;
  }

  async getWeeklyChallenges() {
    return this.weeklyMissions;
  }
}
