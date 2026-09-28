import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AIRequestType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeForCache } from './ai-guard';

/**
 * Bộ nhớ đệm câu trả lời AI, tra bằng băm câu hỏi đã chuẩn hoá.
 *
 * Câu hỏi du lịch lặp lại rất nhiều ("Đà Lạt mùa nào đẹp?", "Hành lý xách tay
 * mấy kg?"). Trả từ đây mất vài mili giây và **không tốn đồng nào** cho Gemini.
 *
 * Đây là đệm theo *băm chính xác*, không phải theo ngữ nghĩa: hai câu hỏi khác
 * chữ thì vẫn gọi AI. Đổi lại nó không bao giờ trả nhầm câu trả lời của câu
 * hỏi khác — thứ mà đệm ngữ nghĩa ngưỡng lỏng rất dễ mắc.
 */
@Injectable()
export class AiCacheService {
  private readonly logger = new Logger(AiCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hạn dùng theo loại. Thông tin du lịch có tuổi thọ rất khác nhau: thời tiết
   * đổi từng ngày, còn "Đà Lạt mùa nào đẹp" thì cả tháng vẫn đúng.
   *
   * Loại nào phụ thuộc dữ liệu riêng của chuyến (roast chi tiêu, mood squad)
   * thì **không đệm** — trả lại câu cũ là sai hẳn.
   */
  private static readonly TTL_HOURS: Partial<Record<AIRequestType, number>> = {
    WEATHER_ADVICE: 24,
    DESTINATION_SUGGEST: 24 * 30,
    ITINERARY_PLAN: 24 * 7,
    CAPTION_GEN: 24 * 7,
  };

  private key(type: AIRequestType, tripId: string | undefined, prompt: string) {
    return createHash('sha256')
      .update(`${type}|${tripId ?? ''}|${normalizeForCache(prompt)}`)
      .digest('hex');
  }

  /** Loại này có được đệm không. */
  cacheable(type: AIRequestType): boolean {
    return AiCacheService.TTL_HOURS[type] !== undefined;
  }

  /** Câu trả lời còn hạn, hoặc `null`. Lỗi đệm không bao giờ chặn yêu cầu. */
  async get(
    type: AIRequestType,
    tripId: string | undefined,
    prompt: string,
  ): Promise<object | null> {
    if (!this.cacheable(type)) return null;
    try {
      const row = await this.prisma.aiResponseCache.findUnique({
        where: { key: this.key(type, tripId, prompt) },
      });
      if (!row || row.expiresAt <= new Date()) return null;
      // Đếm lượt trúng để biết đệm có đáng giữ không. Không chờ.
      void this.prisma.aiResponseCache
        .update({
          where: { key: row.key },
          data: { hitCount: { increment: 1 } },
        })
        .catch(() => undefined);
      return row.response as object;
    } catch (e) {
      this.logger.warn(`Không đọc được đệm AI: ${(e as Error).message}`);
      return null;
    }
  }

  /** Lưu câu trả lời. Hỏng thì bỏ qua — đệm không được làm hỏng luồng chính. */
  async set(
    type: AIRequestType,
    tripId: string | undefined,
    prompt: string,
    response: object,
  ): Promise<void> {
    const hours = AiCacheService.TTL_HOURS[type];
    if (hours === undefined) return;
    const key = this.key(type, tripId, prompt);
    const expiresAt = new Date(Date.now() + hours * 3600_000);
    try {
      await this.prisma.aiResponseCache.upsert({
        where: { key },
        create: { key, type, response, expiresAt },
        update: { response, expiresAt, hitCount: 0 },
      });
    } catch (e) {
      this.logger.warn(`Không ghi được đệm AI: ${(e as Error).message}`);
    }
  }

  /** Dọn bản ghi hết hạn. Trả số dòng đã xoá. */
  async purgeExpired(): Promise<number> {
    const r = await this.prisma.aiResponseCache.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return r.count;
  }
}
