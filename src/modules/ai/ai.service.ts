import { Injectable } from '@nestjs/common';
import { AIRequestType, AIStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AiService {
  constructor(private prisma: PrismaService) {}

  private queueItems: any[] = [
    { id: 'q-1', task: 'Tổng hợp video kỷ niệm Kyoto Matsuri 🎥', progress: 65, status: 'PROCESSING' },
    { id: 'q-2', task: 'Phân tích hóa đơn lẩu gà lá é 💸', progress: 100, status: 'COMPLETED' },
  ];

  private savedPromptsList: any[] = [
    { id: 'p-1', title: 'Tối ưu hóa hóa đơn của tôi 💸', prompt: 'Hãy quét và chỉ ra ai đang nợ tiền tôi nhiều nhất' },
    { id: 'p-2', title: 'Lịch trình chill mây sớm 🌲', prompt: 'Gợi ý lịch trình ngắm mây 5h sáng tại Đà Lạt ít người nhất' },
  ];

  async createRequest(
    userId: string,
    tripId: string | undefined,
    type: AIRequestType,
    prompt: string,
  ) {
    let response: any = null;
    let status: AIStatus = 'PENDING';

    if (type === 'VIBE_MATCH') {
      status = 'COMPLETED';
      response = {
        matchPercentage: 87,
        vibeTags: ['aesthetic hidden gem', 'chill coffee squad'],
        analysis: 'This is giving: main character Đà Lạt episode. Your squad would absolutely romanticize this cafe. ✨',
        locationName: 'The Hill Station',
        locationAddress: 'Old Town, Hội An'
      };
    } else if (type === 'EXPENSE_ROAST') {
      status = 'COMPLETED';
      response = {
        roastText: 'Phú Khang: main character energy nhưng chưa trả 420k 😭',
        progressPercent: 80,
        totalExpenses: 500000
      };
    }

    return this.prisma.aIRequest.create({
      data: { userId, tripId, type, prompt, status, response },
    });
  }

  async findAll(userId: string) {
    return this.prisma.aIRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async findByTrip(tripId: string) {
    return this.prisma.aIRequest.findMany({
      where: { tripId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateResult(id: string, response: object, status: AIStatus) {
    return this.prisma.aIRequest.update({
      where: { id },
      data: { response, status },
    });
  }

  // --- MODULE 10 (AI FLOW) EXTENSIONS ---

  async getPersonalityRoast(tripId: string) {
    return {
      tripId,
      squadAnalysis: [
        { name: 'Alex Nguyễn', type: 'Chúa Tể Hỗn Loạn 👑', roast: 'Thích tiêu tiền nhóm và chia nợ bằng vòng quay roulette!' },
        { name: 'Trần Bình', type: 'Thần Tài Săn Deal 💸', roast: 'Checkin chậm nhất nhưng đòi hóa đơn chi tiết nhất nhóm!' },
        { name: 'Minh Nhật', type: 'Phượt Thủ Selfie 🤳', roast: 'Gom 90% bộ nhớ album chung chỉ để up ảnh của mình!' },
      ],
    };
  }

  async getSquadMood(tripId: string) {
    return {
      tripId,
      overallMood: 'Chill & Hơi Hỗn Loạn 🎢',
      tensionLevel: 2, // 1-5
      moodAnalysis: 'Tình trạng ổn định. Có một chút tranh cãi nhẹ về hóa đơn lẩu gà nhưng đã được khôi phục 100% tình hữu nghị qua MoMo!',
    };
  }

  async getRecommendationTimeline(tripId: string) {
    return [
      { time: '08:00 AM', location: 'Cafe The Hill Station ☕', reason: 'AI Vibe Match đạt 92% với tính cách chill của cả nhóm.' },
      { time: '02:00 PM', location: 'Đền Fushimi Inari ⛩️', reason: 'Thời tiết mát mẻ nhất trong ngày, tránh nắng gắt.' },
    ];
  }

  async getSavedPrompts() {
    return this.savedPromptsList;
  }

  async getGenerationQueue() {
    return this.queueItems;
  }
}
