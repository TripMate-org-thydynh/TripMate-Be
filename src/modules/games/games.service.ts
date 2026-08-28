import { Injectable } from '@nestjs/common';
import { GameType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class GamesService {
  constructor(private prisma: PrismaService) {}

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

  /// Kho thử thách. Đây là nội dung game biên soạn sẵn (hợp lệ), nhưng
  /// `{member}` được thay bằng TÊN THẬT của một thành viên trong chuyến.
  /// Trước đây dare hardcode tên "Lê Minh", "Alex Nguyễn" — những người
  /// không hề có trong nhóm.
  private static readonly DARES: Array<{
    text: string;
    xp: number;
    chaos: string;
    needsMember: boolean;
  }> = [
    {
      text: 'Uống hết ly nước này trong 5 giây! 🍺',
      xp: 100,
      chaos: 'Nhẹ 😌',
      needsMember: false,
    },
    {
      text: 'Hát một bài thiếu nhi bằng giọng em bé! 🎤',
      xp: 120,
      chaos: 'Vừa 😄',
      needsMember: false,
    },
    {
      text: 'Chụp một tấm dìm hàng {member} rồi đăng lên Moments! 📸',
      xp: 200,
      chaos: 'Căng 🔥',
      needsMember: true,
    },
    {
      text: 'Để {member} chọn món cho bạn ở bữa tiếp theo! 🍜',
      xp: 150,
      chaos: 'Vừa 😄',
      needsMember: true,
    },
    {
      text: 'Nhắn cho {member} một lời khen thật lòng 💛',
      xp: 80,
      chaos: 'Nhẹ 😌',
      needsMember: true,
    },
    {
      text: 'Kể một bí mật chưa ai trong nhóm biết! 🤫',
      xp: 250,
      chaos: 'Cực căng 💥',
      needsMember: false,
    },
    {
      text: 'Trả tiền món tiếp theo cho cả nhóm! 💸',
      xp: 300,
      chaos: 'Cực căng 💥',
      needsMember: false,
    },
    {
      text: 'Đổi chỗ ngồi với {member} trong 30 phút! 🔄',
      xp: 90,
      chaos: 'Nhẹ 😌',
      needsMember: true,
    },
    {
      text: 'Làm MC giới thiệu địa điểm tiếp theo như hướng dẫn viên! 🎥',
      xp: 180,
      chaos: 'Căng 🔥',
      needsMember: false,
    },
    {
      text: 'Cho {member} đăng 1 story bằng điện thoại của bạn! 📱',
      xp: 280,
      chaos: 'Cực căng 💥',
      needsMember: true,
    },
  ];

  /// Thử thách ngẫu nhiên. Có `tripId` thì boốc tên một thành viên thật
  /// để thử thách có tính cá nhân — đó mới là chỗ vui của game.
  async getRandomDare(tripId?: string) {
    let memberNames: string[] = [];
    if (tripId) {
      const members = await this.prisma.tripMember.findMany({
        where: { tripId },
        include: { user: { select: { name: true } } },
      });
      memberNames = members.map((m) => m.user.name).filter(Boolean);
    }

    // Không biết thành viên nào thì chỉ lấy dare không cần tên.
    const pool =
      memberNames.length > 0
        ? GamesService.DARES
        : GamesService.DARES.filter((d) => !d.needsMember);

    const dare = pool[Math.floor(Math.random() * pool.length)];
    const member =
      memberNames.length > 0
        ? memberNames[Math.floor(Math.random() * memberNames.length)]
        : '';

    return {
      dareText: dare.text.replace('{member}', member),
      xpReward: dare.xp,
      chaosFactor: dare.chaos,
    };
  }

  /// Bảng xếp hạng theo đóng góp THẬT của từng thành viên.
  ///
  /// Trước đây màn leaderboard trong app hiển thị 5 người chơi bịa
  /// (Sam / Alex / Jordan / Taylor / Casey) không liên quan gì tới nhóm thật.
  async getLeaderboard(tripId: string) {
    const members = await this.prisma.tripMember.findMany({
      where: { tripId },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (members.length === 0) return [];

    const userIds = members.map((m) => m.userId);
    const [moments, expenses, itineraries, notes] = await Promise.all([
      this.prisma.moment.groupBy({
        by: ['userId'],
        where: { tripId, deletedAt: null, userId: { in: userIds } },
        _count: { _all: true },
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

    const rows = members.map((m) => {
      const nMoments = countOf(moments, 'userId', m.userId);
      const nExpenses = countOf(expenses, 'paidById', m.userId);
      const nPlans = countOf(itineraries, 'userId', m.userId);
      const nNotes = countOf(notes, 'authorId', m.userId);
      const xp = nMoments * 40 + nExpenses * 20 + nPlans * 30 + nNotes * 15;
      return {
        userId: m.userId,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        moments: nMoments,
        expenses: nExpenses,
        plans: nPlans,
        notes: nNotes,
        xp,
      };
    });

    rows.sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name));
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /// XP của squad tính từ HOẠT ĐỘNG THẬT trong chuyến.
  ///
  /// Trước đây hàm này trả cứng level 4 / 1420 XP lưu trong biến in-memory
  /// (mất sạch mỗi lần restart) kèm 2 "perk" bịa.
  async getXpProgression(tripId: string) {
    const [itineraries, expenses, moments, games, members, polls] =
      await Promise.all([
        this.prisma.itineraryItem.count({ where: { tripId } }),
        this.prisma.expense.count({ where: { tripId } }),
        this.prisma.moment.count({ where: { tripId, deletedAt: null } }),
        this.prisma.gameSession.count({ where: { tripId } }),
        this.prisma.tripMember.count({ where: { tripId } }),
        this.prisma.poll.count({ where: { tripId } }),
      ]);

    // Biểu điểm: mỗi loại đóng góp khác nhau để khuyến khích dùng đủ tính năng.
    // Chỉ trả `key`; client tự dịch nhãn theo ngôn ngữ đang chọn. Trả label
    // tiếng Việt cứng từ BE sẽ lẫn ngôn ngữ khi app đang ở tiếng Anh.
    const breakdown = [
      { key: 'itinerary', count: itineraries, xpEach: 30 },
      { key: 'expense', count: expenses, xpEach: 20 },
      { key: 'moment', count: moments, xpEach: 40 },
      { key: 'game', count: games, xpEach: 60 },
      { key: 'poll', count: polls, xpEach: 25 },
      { key: 'member', count: members, xpEach: 50 },
    ].map((b) => ({ ...b, xp: b.count * b.xpEach }));

    const currentXP = breakdown.reduce((sum, b) => sum + b.xp, 0);

    // Mỗi level cần nhiều XP hơn level trước: 500, 1100, 1800, 2600...
    const levelCost = (lv: number) => 500 + (lv - 1) * 100;
    let squadLevel = 1;
    let spent = 0;
    while (spent + levelCost(squadLevel) <= currentXP) {
      spent += levelCost(squadLevel);
      squadLevel++;
    }

    return {
      tripId,
      squadLevel,
      currentXP,
      levelStartXP: spent,
      nextLevelXP: spent + levelCost(squadLevel),
      breakdown,
    };
  }

  /// Nhiệm vụ tuần — mục tiêu cố định nhưng TIẾN ĐỘ tính từ dữ liệu thật.
  async getWeeklyChallenges(tripId: string) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [moments, expenses, itineraries, notes] = await Promise.all([
      this.prisma.moment.count({
        where: { tripId, deletedAt: null, createdAt: { gte: since } },
      }),
      this.prisma.expense.count({
        where: { tripId, createdAt: { gte: since } },
      }),
      this.prisma.itineraryItem.count({
        where: { tripId, createdAt: { gte: since } },
      }),
      this.prisma.tripNote.count({
        where: { tripId, createdAt: { gte: since } },
      }),
    ]);

    // `titleKey`/`descKey` — client dịch. Mục tiêu do BE quyđịnh, tiến độ tính thật.
    const defs = [
      { id: 'week-moments', current: moments, target: 3, rewardXP: 400 },
      { id: 'week-expenses', current: expenses, target: 5, rewardXP: 300 },
      { id: 'week-plan', current: itineraries, target: 4, rewardXP: 350 },
      { id: 'week-notes', current: notes, target: 2, rewardXP: 200 },
    ];

    return defs.map((d) => ({
      ...d,
      completed: d.current >= d.target,
      percent: Math.min(100, Math.round((d.current / d.target) * 100)),
    }));
  }

  /**
   * Nhiệm vụ trong NGÀY của squad — tiến độ đếm thật từ hôm nay.
   *
   * Màn Daily Squad Missions trước đây in cứng "Upload 5 memories 3/5",
   * "Visit 3 cafes 1/3"... nên ai mở ra cũng thấy mình đang dở dang những việc
   * chưa từng làm.
   */
  async getDailyMissions(tripId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [moments, expenses, itineraries, games] = await Promise.all([
      this.prisma.moment.count({
        where: { tripId, deletedAt: null, createdAt: { gte: startOfDay } },
      }),
      this.prisma.expense.count({
        where: { tripId, createdAt: { gte: startOfDay } },
      }),
      this.prisma.itineraryItem.count({
        where: { tripId, createdAt: { gte: startOfDay } },
      }),
      this.prisma.gameSession.count({
        where: { tripId, createdAt: { gte: startOfDay } },
      }),
    ]);

    const defs = [
      { id: 'day-moments', current: moments, target: 2, rewardXP: 150 },
      { id: 'day-expenses', current: expenses, target: 1, rewardXP: 100 },
      { id: 'day-plan', current: itineraries, target: 1, rewardXP: 120 },
      { id: 'day-games', current: games, target: 1, rewardXP: 180 },
    ];

    return defs.map((d) => ({
      ...d,
      completed: d.current >= d.target,
      percent: Math.min(100, Math.round((d.current / d.target) * 100)),
    }));
  }

  /// Sự kiện theo mùa — suốt năm, không gắn với địa điểm bịa nào.
  /// Tiến độ tính từ số khoảnh khắc đã đăng trong chuyến.
  async getSeasonalEvents(tripId: string) {
    const moments = await this.prisma.moment.count({
      where: { tripId, deletedAt: null },
    });
    const month = new Date().getMonth() + 1;
    // Chỉ trả id mùa; nhãn do client dịch theo ngôn ngữ đang chọn.
    const season =
      month <= 2 || month === 12
        ? { id: 'season-winter' }
        : month <= 5
          ? { id: 'season-spring' }
          : month <= 8
            ? { id: 'season-summer' }
            : { id: 'season-autumn' };

    return [
      {
        ...season,
        rewardXP: 1000,
        current: moments,
        target: 10,
        completed: moments >= 10,
        percent: Math.min(100, Math.round((moments / 10) * 100)),
      },
    ];
  }
}
