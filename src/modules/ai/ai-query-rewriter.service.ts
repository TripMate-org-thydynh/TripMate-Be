import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { wrapUntrusted } from './ai-guard';

/** Một lượt hội thoại đã diễn ra. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Biến câu hỏi nối tiếp thành câu hỏi đứng một mình được.
 *
 * Người dùng chat kiểu: "Đà Lạt chỗ nào ngắm hoàng hôn đẹp?" → "chỗ thứ 2 vé
 * bao nhiêu?" → "từ đó ra chợ đêm xa không?". Câu thứ ba mà đưa thẳng đi tra
 * cứu thì vô nghĩa, vì "đó" là đâu chỉ có trong lịch sử.
 *
 * Dùng model nhỏ, nhiệt độ 0, hạn giờ ngắn. **Hỏng thì trả lại câu gốc** —
 * viết lại là thứ làm câu trả lời tốt hơn, không phải thứ được quyền chặn
 * tin nhắn của người dùng.
 */
@Injectable()
export class AiQueryRewriterService {
  private readonly logger = new Logger(AiQueryRewriterService.name);
  private readonly genAI: GoogleGenerativeAI | null;

  /** Chỉ nhìn lại vài lượt gần nhất — xa hơn thường không còn liên quan. */
  private static readonly MAX_TURNS = 6;
  private static readonly TIMEOUT_MS = 3000;
  private static readonly MODEL = 'gemini-3.1-flash-lite';

  constructor(config: ConfigService) {
    const key =
      config.get<string>('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    this.genAI = key ? new GoogleGenerativeAI(key) : null;
  }

  /**
   * Câu hỏi độc lập tương ứng với [question] trong ngữ cảnh [history].
   *
   * Không có lịch sử, hoặc câu hỏi đã tự đủ nghĩa → trả nguyên câu gốc, khỏi
   * tốn một lời gọi.
   */
  async rewrite(question: string, history: ChatTurn[]): Promise<string> {
    const q = (question ?? '').trim();
    if (!q || !this.genAI) return q;
    if (!history?.length) return q;
    if (!this.looksDependent(q)) return q;

    const recent = history.slice(-AiQueryRewriterService.MAX_TURNS);
    const transcript = recent
      .map((t) => `${t.role === 'user' ? 'Người dùng' : 'Trợ lý'}: ${t.content}`)
      .join('\n');

    const prompt = [
      'Viết lại câu hỏi cuối thành một câu hỏi ĐỘC LẬP, hiểu được mà không',
      'cần đọc lịch sử. Thay các từ chỉ trỏ ("đó", "chỗ này", "cái thứ 2")',
      'bằng tên cụ thể lấy từ lịch sử.',
      'Giữ nguyên ý định và ngôn ngữ. KHÔNG trả lời câu hỏi.',
      'Chỉ in ra đúng câu hỏi đã viết lại, không thêm gì khác.',
      '',
      wrapUntrusted('history', transcript),
      '',
      wrapUntrusted('question', q),
    ].join('\n');

    try {
      const model = this.genAI.getGenerativeModel({
        model: AiQueryRewriterService.MODEL,
        generationConfig: { temperature: 0, maxOutputTokens: 200 },
      });
      const res = await this.withTimeout(
        model.generateContent(prompt),
        AiQueryRewriterService.TIMEOUT_MS,
      );
      const out = res.response.text().trim().split('\n')[0].trim();
      // Model đôi khi trả lời thay vì viết lại. Câu dài gấp bội câu gốc gần
      // như chắc chắn là câu trả lời — thà dùng câu gốc còn hơn.
      if (!out || out.length > Math.max(200, q.length * 4)) return q;
      return out;
    } catch (e) {
      this.logger.warn(`Viết lại câu hỏi hỏng, dùng câu gốc: ${String(e)}`);
      return q;
    }
  }

  /**
   * Câu có vẻ phụ thuộc ngữ cảnh không.
   *
   * Lọc thô để khỏi gọi model cho những câu đã tự đủ nghĩa — đỡ tiền và đỡ
   * 300ms cho phần lớn tin nhắn.
   */
  private looksDependent(q: string): boolean {
    const s = q.toLowerCase();
    const deictic =
      /\b(đó|đấy|này|kia|nó|họ|chỗ ấy|ở đây|cái (thứ )?\d|thứ (nhất|hai|ba|tư)|còn|vậy|thế)\b/;
    // Câu rất ngắn gần như luôn là câu hỏi nối tiếp ("bao nhiêu tiền?").
    return deictic.test(s) || s.split(/\s+/).length <= 6;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error('rewrite timeout')), ms),
      ),
    ]);
  }
}
