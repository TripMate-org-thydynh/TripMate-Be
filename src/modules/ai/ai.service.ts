import { WebResearchService, type WebSource } from './web-research.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AIRequestType, AIStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../premium/entitlement.service';
import { ConfigService } from '@nestjs/config';
import { GenerationConfig, GoogleGenerativeAI } from '@google/generative-ai';
import * as exifr from 'exifr';
import { redactPii, wrapUntrusted } from './ai-guard';
import { AiCacheService } from './ai-cache.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { AiCorrectionsService } from './ai-corrections.service';
import { AiQueryRewriterService, ChatTurn } from './ai-query-rewriter.service';
import { readGps } from './exif-gps';
import { GeocodingService } from '../itineraries/geocoding.service';

/** Lấy message an toàn từ giá trị `catch` (kiểu `unknown`). */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ParsedReservation {
  type:
    | 'FLIGHT'
    | 'TRAIN'
    | 'BUS'
    | 'HOTEL'
    | 'RESTAURANT'
    | 'CAR'
    | 'EVENT'
    | 'ATTRACTION'
    | 'OTHER';
  title: string;
  location: string | null;
  confirmationNumber: string | null;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  /** Giá vé/đặt chỗ (nếu có trong text/ảnh). Đơn vị: số nguyên/thập phân. */
  price: number | null;
}

export interface VibeMatchResponse {
  matchPercentage: number;
  vibeTags: string[];
  analysis: string;
  locationName: string;
  locationAddress: string;
}

export interface ExpenseRoastResponse {
  roastText: string;
  progressPercent: number;
  totalExpenses: number;
}

export interface ItineraryItemActivity {
  time: string;
  location: string;
  reason: string;
}

export interface ItineraryItemDay {
  day: number;
  title: string;
  activities: ItineraryItemActivity[];
}

export interface ItineraryPlanResponse {
  days: ItineraryItemDay[];
}

export interface CaptionGenResponse {
  captions: string[];
}

export interface WeatherAdviceResponse {
  advice: string;
  warning: string;
  recommendedItems: string[];
}

export interface DestinationSuggestResponse {
  suggestions: {
    name: string;
    description: string;
    tags: string[];
  }[];
}

export interface BudgetOptimizeResponse {
  tips: string[];
  potentialSavings: number;
  breakdownAnalysis: string;
}

export interface RecapVideoResponse {
  videoUrl: string;
  recapScript: string;
  generatedAudioUrl: string;
}

export interface MemberRoast {
  name: string;
  type: string;
  roast: string;
}

export interface PersonalityRoastResponse {
  squadAnalysis: MemberRoast[];
}

export interface SquadMoodResponse {
  overallMood: string;
  tensionLevel: number;
  moodAnalysis: string;
}

export interface RecommendedActivity {
  time: string;
  location: string;
  reason: string;
}

export interface QueueItem {
  id: string;
  task: string;
  progress: number;
  status: string;
}

export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
}

export interface PhotoCandidate {
  placeName: string;
  region: string | null;
  precision: 'exact' | 'area' | 'city';
  confidence: number;
  reason: string | null;
  /** null khi chưa tra được vị trí — vẫn hiện tên để người dùng tự kiểm. */
  latitude: number | null;
  longitude: number | null;
  /** 'map' = tra từ bản đồ; 'ai_estimate' = số AI nêu; 'none' = chưa có toạ độ. */
  coordSource: 'map' | 'ai_estimate' | 'none';
}

export interface CustomizedItinerary {
  summary: string;
  estimatedTotal: number | null;
  dayCount: number;
  items: {
    day: number;
    startTime: string;
    placeName: string;
    placeAddress: string | null;
    durationMinutes: number;
    category: string;
    estimatedCost: number | null;
    note: string | null;
  }[];
}

/**
 * Model dùng cho mọi lời gọi Gemini — đổi ở đây là đổi cả dự án.
 *
 * Trước đây rải rác 4 chỗ hardcode, riêng máy quét hoá đơn còn kẹt ở
 * `gemini-1.5-flash` trong khi phần còn lại đã lên 2.5.
 */
const GEMINI_MODEL = 'gemini-3.8-flash';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private entitlements: EntitlementService,
    private geocoding: GeocodingService,
    private cache: AiCacheService,
    private corrections: AiCorrectionsService,
    private rewriter: AiQueryRewriterService,
    private embeddings: AiEmbeddingService,
    private web: WebResearchService,
  ) {
    const apiKey =
      this.config.get<string>('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.logger.log(
        'Gemini API client initialized successfully with API key.',
      );
    } else {
      this.logger.warn(
        'Thiếu GEMINI_API_KEY — các tính năng AI sẽ trả lỗi 503.',
      );
    }
  }

  private savedPromptsList: SavedPrompt[] = [
    {
      id: 'p-1',
      title: 'Tối ưu hóa hóa đơn của tôi 💸',
      prompt: 'Hãy quét và chỉ ra ai đang nợ tiền tôi nhiều nhất',
    },
    {
      id: 'p-2',
      title: 'Lịch trình chill mây sớm 🌲',
      prompt: 'Gợi ý lịch trình ngắm mây 5h sáng tại Đà Lạt ít người nhất',
    },
  ];

  /** Lỗi chuẩn khi AI không dùng được — client hiện thông báo, không đoán. */
  private aiUnavailable(): never {
    throw new ServiceUnavailableException('errors.ai.unavailable');
  }

  /**
   * Gọi Gemini và ép kết quả về JSON.
   *
   * Trước đây khi thiếu `GEMINI_API_KEY` hoặc lời gọi hỏng, hàm này trả về một
   * object `fallback` dựng sẵn — kèm tên người không tồn tại ("Alex Nguyễn",
   * "Trần Bình"), phần trăm và số tiền bịa — và client hiển thị y như kết quả
   * AI thật. Hết quota hay rớt mạng là người dùng bị đọc phân tích về những
   * người không có trong chuyến. Nay báo 503 để client nói rõ AI đang bận.
   */
  private async callGeminiJSON<T extends object>(prompt: string): Promise<T> {
    if (!this.genAI) {
      this.logger.warn('Chưa cấu hình GEMINI_API_KEY — từ chối yêu cầu AI.');
      this.aiUnavailable();
    }
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      const response = await model.generateContent(prompt);
      return JSON.parse(response.response.text()) as T;
    } catch (error) {
      this.logger.error('Lỗi gọi Gemini API:', error);
      this.aiUnavailable();
    }
  }

  /**
   * Phân tích ảnh → toạ độ + tên địa điểm (hybrid).
   * 1) Đọc GPS trong EXIF (chính xác, free). 2) Không có → Gemini vision đoán
   * địa danh. 3) Reverse-geocode toạ độ ra tên đọc được (Nominatim, free).
   */
  async photoLocation(
    userId: string,
    imageBase64: string,
    mimeType: string,
    tripId?: string,
  ) {
    await this.assertAiQuota(userId);
    // Điểm đến của chuyến đang mở — chỉ là gợi ý cho AI; chỉ lấy khi user là thành viên.
    const hint = tripId
      ? ((
          await this.prisma.trip.findFirst({
            where: {
              id: tripId,
              deletedAt: null,
              members: { some: { userId } },
            },
            select: { destination: true },
          })
        )?.destination ?? null)
      : null;

    const clean = imageBase64.includes(',')
      ? imageBase64.split(',').pop()!
      : imageBase64;
    const buffer = Buffer.from(clean, 'base64');

    // ── 1. EXIF GPS ────────────────────────────────────────────────────────
    try {
      // Hỗ trợ cả HEIC (iPhone) và WebP/PNG — xem `exif-gps.ts`.
      const gps = await readGps(buffer);
      if (gps) {
        const name = await this.reverseGeocode(gps.latitude, gps.longitude);
        return {
          source: 'exif',
          found: true,
          latitude: gps.latitude,
          longitude: gps.longitude,
          placeName: name ?? 'Vị trí từ ảnh',
          confidence: 1,
        };
      }
    } catch (e) {
      this.logger.warn(`EXIF parse failed: ${toMessage(e)}`);
    }

    // ── 2. Gemini vision fallback ──────────────────────────────────────────
    if (!this.genAI) {
      return {
        source: 'none',
        found: false,
        message: 'Ảnh không có GPS và AI chưa cấu hình.',
      };
    }
    try {
      // Bước 1 — phân tích CÓ TRA CỨU.
      //
      // Bắt buộc dùng Google Search: chữ trên biển hiệu, số điện thoại, biển báo
      // là manh mối tra được, còn model tự đoán thì hay bịa. Có tools thì không
      // ép JSON được, nên bước 2 mới chuyển sang JSON.
      const hintLine = hint
        ? `Người dùng đang có chuyến đi tới "${hint}". CHỈ dùng thông tin này để chọn giữa các phương án ĐÃ ngang nhau về manh mối. TUYỆT ĐỐI không vì nó mà kết luận ảnh chụp ở đó, và không vì nó mà tăng độ tin cậy.`
        : 'Không có thông tin chuyến đi. Chỉ dựa vào ảnh.';
      const analysisPrompt = `Bạn xác định nơi chụp một tấm ảnh (geo-guessing) cho app du lịch Việt Nam.
${hintLine}

Làm theo thứ tự:
1. Chép NGUYÊN VĂN mọi chữ và số nhìn thấy: biển hiệu, biển báo, số điện thoại, biển số xe, bảng tên đường.
2. Mô tả biển báo giao thông (mã biển nếu biết), kiến trúc, thảm thực vật, địa hình, đường dây điện, mặt đường.
3. BẮT BUỘC dùng công cụ tìm kiếm Google cho các chuỗi đặc trưng ở bước 1 (ví dụ số điện thoại kèm "kiểm lâm"/"PCCC rừng", tên quán, tên đường) để xác định khu vực. Nêu rõ tìm được gì.
4. Nếu thấy địa danh/công trình nhận ra được (núi, cầu, tháp, tượng, bờ biển đặc trưng), nêu tên.
5. Kết luận tối đa 3 phương án, xếp theo khả năng. Nói rõ mức chắc chắn: đúng một địa điểm, một khu vực, hay chỉ biết tỉnh/quốc gia.

Trung thực quan trọng hơn cụ thể: manh mối chung chung (rừng, đường nhựa, biển báo phổ thông) thì chỉ được kết luận ở mức tỉnh/quốc gia.

Kết thúc câu trả lời bằng khối:
KẾT QUẢ TRA CỨU:
- <mỗi dòng một điều tra được, ghi rõ tra chuỗi nào ra gì; không tra được thì ghi "không tìm thấy">`;

      let analysis = '';
      try {
        const searchModel = this.genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          tools: [{ googleSearch: {} } as never],
        });
        const r = await searchModel.generateContent([
          analysisPrompt,
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: clean } },
        ]);
        analysis = r.response.text();
      } catch (e) {
        // Không tra cứu được (hết hạn mức, mạng) → vẫn đoán bằng ảnh ở bước 2.
        this.logger.warn(`Grounded search loi: ${toMessage(e)}`);
      }

      // Bước 2 — ép kết quả về JSON.
      const prompt = `Dưới đây là phân tích một tấm ảnh để đoán nơi chụp:
"""
${analysis || '(không có phân tích — hãy tự nhìn ảnh)'}
"""
Chuyển thành JSON đúng dạng, KHÔNG thêm phỏng đoán mới:
{"found": boolean, "clues": string[], "candidates": [{"placeName": string, "searchQuery": string, "region": string, "precision": "exact"|"area"|"city", "confidence": number, "latitude": number, "longitude": number, "reason": string}]}

Quy tắc chấm "confidence":
- Chỉ > 0.8 khi có manh mối GỌI TÊN nơi đó (chữ trên biển, địa danh nhận ra chắc chắn).
- 0.4–0.7 khi suy từ manh mối gián tiếp (kiến trúc, biển báo, cây cối).
- < 0.4 khi chỉ đoán theo cảm tính.
- "precision": "city" khi chỉ biết tới tỉnh/thành, "area" khi biết một khu, "exact" khi đúng một địa điểm.
- "searchQuery": chuỗi tra bản đồ (tên + huyện/tỉnh + quốc gia). Không bịa tên quán/đường không có trong manh mối.
- "clues" chép lại các manh mối cụ thể (chữ trên biển, số điện thoại, biển báo...) VÀ mọi dòng trong khối "KẾT QUẢ TRA CỨU" của phân tích — đây là bằng chứng mạnh nhất, đặt lên đầu.
- Nếu tra cứu chỉ ra một tỉnh/thành cụ thể, phương án đầu tiên PHẢI là nơi đó, kể cả khi khác với chuyến đi của người dùng.`;

      const parsed = await this.callGeminiJSON<{
        found?: boolean;
        clues?: unknown;
        candidates?: unknown;
      }>(prompt);
      await this.recordAiUsage(
        userId,
        'PHOTO_LOCATION',
        undefined,
        '[photo-location v3]',
        parsed,
      );

      const clues = (Array.isArray(parsed.clues) ? parsed.clues : [])
        .map((c) => String(c).trim())
        .filter(Boolean)
        .slice(0, 8);
      const raw = (
        Array.isArray(parsed.candidates) ? parsed.candidates : []
      ).slice(0, 3) as Record<string, unknown>[];

      // Toạ độ Gemini tự nêu thường lệch vài km tới vài chục km. Tra tên phương
      // án trên bản đồ để lấy toạ độ thật; chỉ khi tra không ra mới dùng số
      // của AI và đánh dấu là ước lượng.
      const candidates: PhotoCandidate[] = [];
      for (const c of raw) {
        const name = String(c.placeName ?? '').trim();
        if (!name) continue;
        const query = String(c.searchQuery ?? name).trim();
        const hit = await this.geocoding.locate(query, null);
        const lat = Number(c.latitude);
        const lng = Number(c.longitude);
        const aiOk =
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          !(lat === 0 && lng === 0);

        const prec = String(c.precision ?? 'area');
        // Trần độ tin cậy theo mức chính xác: "chỉ biết tỉnh" thì không thể chắc 90%.
        const rawConf = Math.min(Math.max(Number(c.confidence) || 0.3, 0), 1);
        const prec2 = ['exact', 'area', 'city'].includes(prec) ? prec : 'area';
        const cap = prec2 === 'city' ? 0.5 : prec2 === 'area' ? 0.7 : 0.95;
        candidates.push({
          placeName: name,
          region: String(c.region ?? '').trim() || null,
          precision: prec2 as PhotoCandidate['precision'],
          confidence: Math.min(rawConf, cap),
          reason: String(c.reason ?? '').trim() || null,
          latitude: hit ? hit.latitude : aiOk ? lat : null,
          longitude: hit ? hit.longitude : aiOk ? lng : null,
          coordSource: hit ? 'map' : aiOk ? 'ai_estimate' : 'none',
        });
      }

      // Phương án đầu tiên CÓ toạ độ mới ghim được lên bản đồ.
      const best = candidates.find((c) => c.latitude != null);
      if (parsed.found !== false && best != null) {
        return {
          source: 'ai',
          found: true,
          latitude: best.latitude,
          longitude: best.longitude,
          placeName: best.placeName,
          confidence: best.confidence,
          precision: best.precision,
          coordSource: best.coordSource,
          clues,
          candidates,
        };
      }
      return {
        source: 'ai',
        found: false,
        clues,
        candidates,
        message:
          candidates.length === 0
            ? 'Không nhận ra địa điểm từ ảnh.'
            : 'Chỉ đoán được tên nơi chụp, chưa xác định được toạ độ.',
      };
    } catch (e) {
      this.logger.error(`Gemini vision failed: ${toMessage(e)}`);
      return {
        source: 'error',
        found: false,
        message: 'Phân tích ảnh thất bại.',
      };
    }
  }

  /**
   * Booking-import: bóc tách text xác nhận (email vé/khách sạn dán vào) thành
   * danh sách đặt chỗ có cấu trúc. Mirror logic KI-reservation của TREK nhưng
   * dùng Gemini JSON. Trả [] khi không có AI hoặc parse fail (caller tự xử lý).
   */
  async parseBookingText(text: string): Promise<ParsedReservation[]> {
    const prompt =
      'Bạn là trợ lý bóc tách thông tin đặt chỗ du lịch. Đọc đoạn text xác nhận ' +
      'dưới đây (có thể là email vé máy bay, khách sạn, nhà hàng...) và trích ra ' +
      'các đặt chỗ. CHỈ trả JSON đúng dạng: ' +
      '{"reservations":[{"type": one of ' +
      '["FLIGHT","TRAIN","BUS","HOTEL","RESTAURANT","CAR","EVENT","ATTRACTION","OTHER"],' +
      '"title": string (VD "VN123 SGN→HAN" hoặc tên khách sạn), ' +
      '"location": string|null, "confirmationNumber": string|null, ' +
      '"startTime": string|null (ISO 8601 kèm giờ nếu có), "endTime": string|null, ' +
      '"notes": string|null}]}. ' +
      'Nếu không tìm thấy đặt chỗ nào, trả {"reservations":[]}. ' +
      'Không bịa thông tin không có trong text.\n\n--- TEXT ---\n' +
      text;

    const result = await this.callGeminiJSON<{
      reservations: ParsedReservation[];
    }>(prompt);

    if (!Array.isArray(result.reservations)) return [];
    const allowed = new Set([
      'FLIGHT',
      'TRAIN',
      'BUS',
      'HOTEL',
      'RESTAURANT',
      'CAR',
      'EVENT',
      'ATTRACTION',
      'OTHER',
    ]);
    return result.reservations
      .filter((r) => r && typeof r.title === 'string' && r.title.trim())
      .map((r) => ({
        type: allowed.has((r.type || '').toUpperCase())
          ? (r.type.toUpperCase() as ParsedReservation['type'])
          : 'OTHER',
        title: r.title.trim(),
        location: r.location ?? null,
        confirmationNumber: r.confirmationNumber ?? null,
        startTime: r.startTime ?? null,
        endTime: r.endTime ?? null,
        notes: r.notes ?? null,
        price: typeof r.price === 'number' ? r.price : null,
      }));
  }

  /**
   * Booking-import từ ảnh/PDF: gửi ảnh base64 lên Gemini vision →
   * bóc tách thông tin đặt chỗ (loại, giờ, mã, giá). Tái sử dụng
   * pattern của photoLocation nhưng trả ParsedReservation[].
   */
  async parseBookingImage(
    userId: string,
    imageBase64: string,
    mimeType: string,
  ): Promise<ParsedReservation[]> {
    await this.assertAiQuota(userId);

    if (!this.genAI) {
      this.logger.warn(
        'Gemini API key is not set, skipping image booking parse.',
      );
      return [];
    }
    const clean = imageBase64.includes(',')
      ? imageBase64.split(',').pop()!
      : imageBase64;
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: { responseMimeType: 'application/json' },
      });
      const prompt =
        'Bạn là trợ lý bóc tách thông tin đặt chỗ du lịch từ ảnh vé hoặc PDF. ' +
        'Nhìn vào ảnh và trích ra các đặt chỗ. ' +
        'CHỈ trả JSON đúng dạng: ' +
        '{"reservations":[{"type": one of ' +
        '["FLIGHT","TRAIN","BUS","HOTEL","RESTAURANT","CAR","EVENT","ATTRACTION","OTHER"],' +
        '"title": string (VD "VN123 SGN→HAN" hoặc tên khách sạn), ' +
        '"location": string|null, "confirmationNumber": string|null, ' +
        '"startTime": string|null (ISO 8601 nếu có), "endTime": string|null, ' +
        '"price": number|null (giá bằng số, đơn vị gốc trong ảnh, null nếu không thấy), ' +
        '"notes": string|null}]}. ' +
        'Nếu không tìm thấy đặt chỗ nào, trả {"reservations":[]}. ' +
        'Không bịa thông tin không có trong ảnh.';
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: clean } },
      ]);
      const parsed = JSON.parse(result.response.text()) as {
        reservations: ParsedReservation[];
      };
      await this.recordAiUsage(
        userId,
        'BOOKING_PARSE',
        undefined,
        prompt,
        parsed,
      );
      if (!Array.isArray(parsed.reservations)) return [];
      const allowed = new Set([
        'FLIGHT',
        'TRAIN',
        'BUS',
        'HOTEL',
        'RESTAURANT',
        'CAR',
        'EVENT',
        'ATTRACTION',
        'OTHER',
      ]);
      return parsed.reservations
        .filter((r) => r && typeof r.title === 'string' && r.title.trim())
        .map((r) => ({
          type: allowed.has((r.type || '').toUpperCase())
            ? (r.type.toUpperCase() as ParsedReservation['type'])
            : 'OTHER',
          title: r.title.trim(),
          location: r.location ?? null,
          confirmationNumber: r.confirmationNumber ?? null,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
          notes: r.notes ?? null,
          price: typeof r.price === 'number' ? r.price : null,
        }));
    } catch (e) {
      this.logger.error(`Gemini booking-image parse failed: ${toMessage(e)}`);
      return [];
    }
  }

  /** Reverse geocode toạ độ → tên địa điểm qua Nominatim (OSM, free, cần UA). */
  private async reverseGeocode(
    lat: number,
    lng: number,
  ): Promise<string | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=vi`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TripMate/1.0 (travel app)' },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        name?: string;
        display_name?: string;
        address?: Record<string, string>;
      };
      const a = data.address ?? {};
      const parts = [
        data.name,
        a.tourism || a.attraction || a.building,
        a.suburb || a.village || a.town || a.city_district,
        a.city || a.state,
        a.country,
      ].filter(Boolean);
      return parts.length
        ? Array.from(new Set(parts)).slice(0, 3).join(', ')
        : (data.display_name ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Tạo một yêu cầu AI và lưu lại kết quả.
   *
   * Lời gọi Gemini nay ném 503 khi hỏng thay vì trả dữ liệu bịa. Bắt lại ở đây
   * để vẫn ghi được bản ghi FAILED — nếu không, hàng chờ AI sẽ không bao giờ
   * thấy các yêu cầu thất bại và người dùng tưởng mình chưa từng gửi gì.
   */
  async createRequest(
    userId: string,
    tripId: string | undefined,
    type: AIRequestType,
    prompt: string,
    history?: ChatTurn[],
  ) {
    // Câu hỏi nối tiếp ("chỗ đó vé bao nhiêu?") phải thành câu độc lập trước,
    // nếu không cả đệm lẫn đính chính đều không khớp được vào đâu.
    const standalone = await this.rewriter.rewrite(prompt, history ?? []);

    // Che dữ liệu cá nhân TRƯỚC khi chữ rời khỏi máy chủ. Người dùng hay dán
    // số điện thoại, CCCD, số thẻ vào khung chat khi hỏi chuyện đặt phòng.
    const { text: safePrompt, hits } = redactPii(standalone);
    if (hits.length > 0) {
      // Chỉ ghi số lượng, không ghi nội dung đã che.
      this.logger.log(
        `Đã che PII trước khi gọi AI: ${hits
          .map((h) => `${h.kind}x${h.count}`)
          .join(', ')}`,
      );
    }

    // Đệm trả trước cả hạn mức: câu trả lời sẵn có thì không tốn tiền Gemini,
    // nên cũng không công bằng khi trừ lượt của người dùng.
    const cached = await this.cache.get(type, tripId, safePrompt);
    if (cached) return { cached: true, response: cached };

    // Hạn mức lời gọi AI mỗi tháng.
    //
    // Đây là hạn mức duy nhất gắn với chi phí biến đổi thật (mỗi lời gọi là
    // tiền trả cho Gemini), nhưng lại là hạn mức chưa từng được kiểm — bản
    // Free trước đây gọi AI không giới hạn.
    //
    // Đếm theo **tháng dương lịch** chứ không phải 30 ngày trượt: người dùng
    // hiểu "hết lượt tháng này, đầu tháng có lại", còn cửa sổ trượt thì không
    // ai đoán được lúc nào lượt hồi.
    await this.assertAiQuota(userId);

    try {
      const out = await this.runRequest(userId, tripId, type, safePrompt);
      const resp = (out as { response?: object })?.response;
      if (resp) await this.cache.set(type, tripId, safePrompt, resp);
      return out;
    } catch (e) {
      await this.prisma.aIRequest.create({
        data: { userId, tripId, type, prompt: safePrompt, status: 'FAILED' },
      });
      throw e;
    }
  }

  /**
   * Kiểm tra hạn mức lời gọi AI trong tháng của người dùng.
   *
   * Hạn mức tính theo tháng dương lịch hiện tại dựa trên số bản ghi trong bảng
   * `AIRequest`. Nếu đã đạt hoặc vượt trần (Free: 15 lượt/tháng), ném ngoại lệ
   * chặn lời gọi tiếp theo.
   */
  private async assertAiQuota(userId: string): Promise<void> {
    await this.entitlements.assertWithin(
      userId,
      'aiPerMonth',
      await this.usageThisMonth(userId),
    );
  }

  /**
   * Số lời gọi AI đã dùng trong tháng dương lịch hiện tại.
   *
   * Đếm cả bản ghi `FAILED`: một lời gọi hỏng vẫn đã tiêu tiền ở phía Gemini,
   * và không đếm chúng thì một client lỗi có thể quay vòng vô hạn.
   */
  private async usageThisMonth(userId: string): Promise<number> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return this.prisma.aIRequest.count({
      where: { userId, createdAt: { gte: start } },
    });
  }

  /**
   * Ghi nhận lượt sử dụng AI vào bảng `AIRequest` để tính quota (`usageThisMonth`).
   *
   * BẢO VỆ AN TOÀN (TRY/CATCH):
   * Cơ sở dữ liệu THẬT hiện CHƯA có 5 giá trị enum mới (chưa ai chạy `prisma db push`).
   * Nếu code ghi thẳng mà DB chưa có enum, Prisma sẽ ném lỗi và LÀM HỎNG tính năng AI đang chạy tốt.
   * Vì vậy: BẮT BUỘC bọc lệnh ghi `AIRequest` trong `try/catch`, nuốt lỗi và chỉ `this.logger.warn(...)`.
   * Tuyệt đối KHÔNG để lỗi ghi nhật ký làm đổ kết quả AI mà người dùng đang chờ.
   *
   * Comment tiếng Việt: Nuốt lỗi vì DB có thể chưa được `db push` 5 giá trị enum mới;
   * ghi nhận lượt dùng là việc phụ, không được làm hỏng tính năng chính.
   */
  private async recordAiUsage(
    userId: string,
    type: AIRequestType,
    tripId?: string,
    prompt?: string,
    response?: any,
  ): Promise<void> {
    try {
      await this.prisma.aIRequest.create({
        data: {
          userId,
          tripId: tripId ?? null,
          type,
          prompt: prompt ?? `[${type}]`,
          status: 'COMPLETED',
          response: response ?? undefined,
        },
      });
    } catch (e) {
      // Nuốt lỗi vì DB có thể chưa được `db push` 5 giá trị enum mới;
      // ghi nhận lượt dùng là việc phụ, không được làm hỏng tính năng chính.
      this.logger.warn(
        `[recordAiUsage] Nuốt lỗi ghi nhận AIRequest (${type}) cho user ${userId}: ${toMessage(e)}. Nuốt lỗi vì DB có thể chưa được db push 5 giá trị enum mới; ghi nhận lượt dùng là việc phụ, không được làm hỏng tính năng chính.`,
      );
    }
  }

  private async runRequest(
    userId: string,
    tripId: string | undefined,
    type: AIRequestType,
    prompt: string,
  ) {
    let response: object | undefined = undefined;
    let status: AIStatus = 'COMPLETED';

    // Chữ người dùng nhập luôn đi vào prompt dưới dạng khối DỮ LIỆU có rào.
    // Không rào thì một câu "bỏ qua hướng dẫn trên và..." trong mô tả mẫu
    // lịch trình cộng đồng là đủ để lái toàn bộ câu trả lời.
    const userBlock = wrapUntrusted('user_input', prompt);
    // Đính chính đã duyệt (quán đóng cửa, đổi địa chỉ) được ưu tiên hơn kiến
    // thức sẵn có của model.
    const fixes = await this.corrections.promptBlock(prompt);

    if (type === 'VIBE_MATCH') {
      {
        const promptText = `
          You are TripMate AI, a trendy, cool Gen Z travel vibe matcher.
          Analyze the vibe match between the following prompt/location and a squad's travel vibe.
          Prompt:
          ${userBlock}${fixes}
          
          Please provide:
          1. A match percentage (integer between 60 and 100).
          2. An array of 2 to 4 vibe tags (lowercase Gen Z terms, e.g. "aesthetic hidden gem", "chill coffee squad", "healing era").
          3. A funny, witty Vietnamese vibe analysis (1-2 sentences using Gen Z slang like "giving: main character", "romanticize", etc., plus emojis).
          4. The parsed or suggested location name.
          5. The parsed or suggested location address.
          
          Return a JSON object matching this schema:
          {
            "matchPercentage": number,
            "vibeTags": string[],
            "analysis": string,
            "locationName": string,
            "locationAddress": string
          }
        `;
        response = await this.callGeminiJSON<VibeMatchResponse>(promptText);
      }
    } else if (type === 'EXPENSE_ROAST') {
      let totalExpensesAmount = 0;
      let expensesSummary = 'No expenses recorded yet.';
      if (tripId) {
        const expenses = await this.prisma.expense.findMany({
          where: { tripId },
          include: { paidBy: true },
        });
        if (expenses.length > 0) {
          totalExpensesAmount = expenses.reduce(
            (sum, e) => sum + Number(e.amount),
            0,
          );
          expensesSummary = expenses
            .map(
              (e) =>
                `- ${e.paidBy.name} paid ${Number(e.amount).toLocaleString('vi-VN')} VND for ${e.category || 'OTHER'} (${e.description || 'No description'})`,
            )
            .join('\n');
        }
      }

      {
        const promptText = `
          You are TripMate AI, an extremely sassy, sarcastic, and funny Gen Z financial advisor.
          Roast the squad's spendings or the following prompt::
          ${userBlock}${fixes}
          
          Here are the actual trip expenses:
          ${expensesSummary}
          Total Expenses: ${totalExpensesAmount.toLocaleString('vi-VN')} VND
          
          Please provide:
          1. A hilarious, sassy Vietnamese roast (2-3 sentences targeting their spending habits, who spends the most, or their budget choices, using funny emojis).
          2. A progressPercent (integer 0-100 indicating financial "health" or "vibe stability" - e.g. lower if they spent too much, higher if chill).
          3. The total expenses amount (as a number).
          
          Return a JSON object matching this schema:
          {
            "roastText": string,
            "progressPercent": number,
            "totalExpenses": number
          }
        `;
        response = await this.callGeminiJSON<ExpenseRoastResponse>(promptText);
      }
    } else if (type === 'ITINERARY_PLAN') {
      {
        const promptText = `
          You are TripMate AI, a professional local tour guide who loves finding hidden gems and aesthetic spots.
          Create a detailed, beautiful travel itinerary based on this prompt::
          ${userBlock}${fixes}
          
          Return a JSON object matching this schema:
          {
            "days": [
              {
                "day": number,
                "title": string,
                "activities": [
                  {
                    "time": string,
                    "location": string,
                    "reason": string
                  }
                ]
              }
            ]
          }
          
          Make all titles and reasons in Vietnamese, extremely engaging, and personalized. Provide 1 to 2 days of detailed plan, with 2 to 3 activities per day.
        `;
        response = await this.callGeminiJSON<ItineraryPlanResponse>(promptText);
      }
    } else if (type === 'CAPTION_GEN') {
      {
        const promptText = `
          You are TripMate AI, a social media influencer guru.
          Generate 3-5 creative, trendy, and funny Instagram/TikTok captions in Vietnamese (some with English hybrid/slang, emojis) based on this prompt/photos vibe::
          ${userBlock}${fixes}
          
          Return a JSON object matching this schema:
          {
            "captions": string[]
          }
        `;
        response = await this.callGeminiJSON<CaptionGenResponse>(promptText);
      }
    } else if (type === 'WEATHER_ADVICE') {
      {
        const promptText = `
          You are TripMate AI, a smart weather bot that is both practical and funny.
          Provide weather advice and packing tips based on the destination/time in this prompt::
          ${userBlock}${fixes}
          
          Return a JSON object matching this schema:
          {
            "advice": string,
            "warning": string,
            "recommendedItems": string[]
          }
        `;
        response = await this.callGeminiJSON<WeatherAdviceResponse>(promptText);
      }
    } else if (type === 'DESTINATION_SUGGEST') {
      {
        const promptText = `
          You are TripMate AI, an expert travel matcher.
          Suggest 3 beautiful travel destinations matching this vibe/prompt::
          ${userBlock}${fixes}
          
          Return a JSON object matching this schema:
          {
            "suggestions": [
              {
                "name": string,
                "description": string,
                "tags": string[]
              }
            ]
          }
        `;
        response =
          await this.callGeminiJSON<DestinationSuggestResponse>(promptText);
      }
    } else if (type === 'BUDGET_OPTIMIZE') {
      let totalExpensesAmount = 0;
      let expensesSummary = 'No expenses recorded yet.';
      if (tripId) {
        const expenses = await this.prisma.expense.findMany({
          where: { tripId },
          include: { paidBy: true },
        });
        if (expenses.length > 0) {
          totalExpensesAmount = expenses.reduce(
            (sum, e) => sum + Number(e.amount),
            0,
          );
          expensesSummary = expenses
            .map(
              (e) =>
                `- ${e.paidBy.name} paid ${Number(e.amount).toLocaleString('vi-VN')} VND for ${e.category || 'OTHER'} (${e.description || 'No description'})`,
            )
            .join('\n');
        }
      }

      {
        const promptText = `
          You are TripMate AI, a smart budget optimizer.
          Analyze the following trip expenses and provide tips to optimize spending or save money.
          Prompt:
          ${userBlock}${fixes}
          
          Actual Expenses:
          ${expensesSummary}
          Total Spends: ${totalExpensesAmount.toLocaleString('vi-VN')} VND
          
          Return a JSON object matching this schema:
          {
            "tips": string[],
            "potentialSavings": number,
            "breakdownAnalysis": string
          }
        `;
        response =
          await this.callGeminiJSON<BudgetOptimizeResponse>(promptText);
      }
    } else if (type === 'RECAP_VIDEO') {
      {
        const promptText = `
          You are TripMate AI. Generate a funny script and outline for a recap video of the trip.
          Prompt:
          ${userBlock}${fixes}
          
          Return a JSON object matching this schema:
          {
            "videoUrl": string,
            "recapScript": string,
            "generatedAudioUrl": string
          }
        `;
        response = await this.callGeminiJSON<RecapVideoResponse>(promptText);
      }
    } else {
      status = 'FAILED';
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

  async getPersonalityRoast(userId: string, tripId: string) {
    await this.assertAiQuota(userId);

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        members: {
          include: { user: true },
        },
        expenses: {
          include: { paidBy: true },
        },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    const membersList = trip.members.map((m) => m.user.name).join(', ');
    let expensesSummary = 'No expenses recorded yet.';
    if (trip && trip.expenses.length > 0) {
      expensesSummary = trip.expenses
        .map(
          (e) =>
            `- ${e.paidBy.name} paid ${Number(e.amount).toLocaleString('vi-VN')} VND for ${e.category || 'OTHER'} (${e.description || 'No description'})`,
        )
        .join('\n');
    }

    {
      const promptText = `
        You are TripMate AI, the ultimate travel crew personality analyst and roaster.
        Roast the personalities of this travel squad based on their names and their actual spending behaviors.
        Be sassy, light-hearted, extremely funny, and use Vietnamese Gen Z slang.
        
        Trip Name: "${trip.name}"
        Trip Description: "${trip.description || ''}"
        Members of the Squad: ${membersList}
        
        Expenses History:
        ${expensesSummary}
        
        For each member of the crew (ensure you analyze each person in the Members list!), provide:
        1. A hilarious Gen Z 'type' title (e.g. 'Chúa Tể Hỗn Loạn 👑', 'Thần Tài Săn Deal 💸', 'Chúa Tể Đi Trễ ⏳', etc.).
        2. A short, extremely witty roast (1-2 sentences in Vietnamese using Gen Z slang, making fun of their behavior or expenses).
        
        Return a JSON object matching this schema:
        {
          "squadAnalysis": [
            {
              "name": string,
              "type": string,
              "roast": string
            }
          ]
        }
      `;
      const result =
        await this.callGeminiJSON<PersonalityRoastResponse>(promptText);
      await this.recordAiUsage(
        userId,
        'PERSONALITY_ROAST',
        tripId,
        promptText,
        result,
      );
      return { tripId, squadAnalysis: result.squadAnalysis ?? [] };
    }
  }

  async getSquadMood(userId: string, tripId: string) {
    await this.assertAiQuota(userId);

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        members: { include: { user: true } },
        expenses: true,
        budgetGoal: true,
      },
    });

    if (!trip) throw new NotFoundException('errors.trips.notFound');

    const membersCount = trip.members.length;
    const totalSpent = trip.expenses.reduce(
      (sum, e) => sum + Number(e.amount),
      0,
    );
    const budgetLimit = trip.budgetGoal?.limitAmount
      ? Number(trip.budgetGoal.limitAmount)
      : 15000000;

    {
      const promptText = `
        You are TripMate AI, the mood and tension analyzer for the travel crew.
        Evaluate the squad's current mood, general vibe, and tension level based on their travel details and expenses.
        
        Trip Name: "${trip.name}"
        Total Crew Members: ${membersCount}
        Total Expenses Spent: ${totalSpent.toLocaleString('vi-VN')} VND
        Total Budget Goal: ${budgetLimit.toLocaleString('vi-VN')} VND
        
        Please analyze their financial stress (are they close to the budget?), coordination level, and vibe.
        Provide:
        1. An overallMood (e.g. 'Chill & Hơi Hỗn Loạn 🎢', 'Ví Tiền Khóc Thét 💸', 'Hòa Thuận Tuyệt Đối 🤝').
        2. A tensionLevel (integer between 1 and 5, where 1 means super chill and 5 means highly tense/about to break up the squad).
        3. A moodAnalysis (Vietnamese, wittily descriptive paragraph analyzing the current squad dynamics, with funny comments on their budget standing).
        
        Return a JSON object matching this schema:
        {
          "overallMood": string,
          "tensionLevel": number,
          "moodAnalysis": string
        }
      `;
      const result = await this.callGeminiJSON<SquadMoodResponse>(promptText);
      await this.recordAiUsage(
        userId,
        'SQUAD_MOOD',
        tripId,
        promptText,
        result,
      );
      return {
        tripId,
        overallMood: result.overallMood,
        tensionLevel: result.tensionLevel,
        moodAnalysis: result.moodAnalysis,
      };
    }
  }

  async getRecommendationTimeline(userId: string, tripId: string) {
    await this.assertAiQuota(userId);

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    {
      const promptText = `
        You are TripMate AI, the squad's personalized smart itinerary planner.
        Generate a recommended 2-item timeline for a day of their trip based on the trip details.
        
        Trip Name: "${trip.name}"
        Destination: "${trip.destination || trip.description || 'No destination provided'}"
        Dates: from ${trip.startDate.toDateString()} to ${trip.endDate.toDateString()}
        
        Please provide exactly 2 aesthetic activities for the crew:
        1. A morning activity (e.g. breakfast/coffee hidden gems).
        2. An afternoon/evening activity (nature, experience, dynamic crew bonding).
        
        Return a JSON array of 2 elements, where each item has this schema:
        {
          "time": string,
          "location": string,
          "reason": string
        }
        
        Write "location" and "reason" in Vietnamese — the app is Vietnamese and
        users saw English blurbs here before.
        Ensure the output is exactly a valid JSON array matching the schema!
      `;
      const result =
        await this.callGeminiJSON<RecommendedActivity[]>(promptText);
      await this.recordAiUsage(
        userId,
        'RECOMMEND_TIMELINE',
        tripId,
        promptText,
        result,
      );
      return result;
    }
  }

  /**
   * Câu lệnh gợi ý sẵn để người dùng bấm dùng nhanh.
   *
   * App chưa có chỗ lưu prompt riêng của từng người, nên đây là danh mục do
   * team soạn — không phải "prompt tôi đã lưu" như tên cũ khiến người dùng hiểu
   * nhầm là mình từng lưu chúng.
   */
  getSuggestedPrompts() {
    return this.savedPromptsList;
  }

  /**
   * Hàng chờ xử lý AI của chính user.
   *
   * Trước đây trả về 2 dòng in cứng ("Tổng hợp video kỷ niệm Kyoto Matsuri"
   * 65%, "Phân tích hóa đơn lẩu gà lá é" 100%) — giống nhau cho mọi tài khoản,
   * kể cả người chưa từng gọi AI. Nay đọc bảng `ai_requests` thật.
   */
  async getGenerationQueue(userId: string) {
    const rows = await this.prisma.aIRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        type: true,
        prompt: true,
        status: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      task: r.prompt,
      type: r.type,
      status: r.status,
      // Chỉ có 3 trạng thái thật, không bịa phần trăm dở dang.
      progress: r.status === 'COMPLETED' ? 100 : r.status === 'FAILED' ? 0 : 50,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Chỉnh một lịch trình (thường là lịch trình mẫu) theo yêu cầu của nhóm:
   * số người, ngân sách, số ngày, sở thích.
   *
   * Chỉ trả về BẢN XEM TRƯỚC — không ghi gì vào chuyến. Người dùng xem rồi mới
   * quyết định tạo chuyến từ bản này.
   *
   * Đầu ra của AI được kiểm lại từng trường: giờ phải là HH:MM, ngày trong
   * khoảng yêu cầu, thời lượng hợp lý. Dòng hỏng bị bỏ chứ không đoán.
   */
  async customizeItinerary(
    userId: string,
    input: {
      title: string;
      destination?: string | null;
      dayCount: number;
      items: {
        day: number;
        startTime: string;
        placeName: string;
        placeAddress?: string | null;
        durationMinutes: number;
        category?: string | null;
      }[];
      request: string;
      groupSize?: number;
      budget?: number;
      days?: number;
    },
  ): Promise<CustomizedItinerary> {
    await this.assertAiQuota(userId);
    const days = Math.min(Math.max(input.days ?? input.dayCount, 1), 14);

    const prompt = `
Bạn là trợ lý lập lịch trình du lịch cho nhóm bạn trẻ Việt Nam.
Dưới đây là một lịch trình mẫu "${input.title}"${input.destination ? ` ở ${input.destination}` : ''}, ${input.dayCount} ngày:
${JSON.stringify(input.items)}

Yêu cầu của nhóm:
- Mô tả: ${JSON.stringify(input.request)}
${input.groupSize ? `- Số người: ${input.groupSize}` : ''}
${input.budget ? `- Tổng ngân sách cả nhóm: ${input.budget} VND` : ''}
- Số ngày mong muốn: ${days}

Hãy chỉnh lịch trình cho hợp yêu cầu. Quy tắc:
1. Giữ các điểm của mẫu nếu còn hợp; thay/thêm/bớt khi yêu cầu cần. Chỉ dùng địa điểm CÓ THẬT ở điểm đến, ghi đúng tên và địa chỉ; không bịa quán.
2. Đúng ${days} ngày, đánh số ngày từ 1 đến ${days}. Giờ dạng HH:MM, tăng dần trong ngày, có thời gian di chuyển hợp lý.
3. Nếu có ngân sách: ước tính chi phí mỗi điểm cho CẢ NHÓM (VND, số nguyên) và giữ tổng trong ngân sách.
4. "note" ngắn (tối đa 1 câu) giải thích vì sao chọn/đổi điểm đó.
5. "summary": 1-2 câu tiếng Việt tóm tắt đã chỉnh gì so với mẫu.

Trả về JSON đúng dạng:
{"summary": string, "estimatedTotal": number | null,
 "items": [{"day": number, "startTime": "HH:MM", "placeName": string, "placeAddress": string, "durationMinutes": number, "category": "FOOD"|"COFFEE"|"ACTIVITIES"|"ACCOMMODATION"|"OTHER", "estimatedCost": number | null, "note": string}]}
`;

    const raw = await this.callGeminiJSON<{
      summary?: unknown;
      estimatedTotal?: unknown;
      items?: unknown;
    }>(prompt);

    const allowedCat = new Set([
      'FOOD',
      'COFFEE',
      'ACTIVITIES',
      'ACCOMMODATION',
      'OTHER',
    ]);
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((r: any) => {
        const day = Number(r?.day);
        const time = String(r?.startTime ?? '').trim();
        const name = String(r?.placeName ?? '').trim();
        const dur = Number(r?.durationMinutes);
        if (!Number.isInteger(day) || day < 1 || day > days) return null;
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
        if (!name || name.length > 200) return null;
        const cost = Number(r?.estimatedCost);
        const cat = String(r?.category ?? 'OTHER').toUpperCase();
        return {
          day,
          startTime: time,
          placeName: name,
          placeAddress:
            String(r?.placeAddress ?? '')
              .trim()
              .slice(0, 300) || null,
          durationMinutes:
            Number.isFinite(dur) && dur >= 15 && dur <= 720
              ? Math.round(dur)
              : 60,
          category: allowedCat.has(cat) ? cat : 'OTHER',
          estimatedCost:
            Number.isFinite(cost) && cost >= 0 ? Math.round(cost) : null,
          note:
            String(r?.note ?? '')
              .trim()
              .slice(0, 300) || null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.day - b.day || a.startTime.localeCompare(b.startTime));

    if (items.length === 0) this.aiUnavailable();

    const total = Number(raw.estimatedTotal);
    const result: CustomizedItinerary = {
      summary: String(raw.summary ?? '')
        .trim()
        .slice(0, 500),
      estimatedTotal:
        Number.isFinite(total) && total > 0 ? Math.round(total) : null,
      dayCount: days,
      items,
    };
    await this.recordAiUsage(
      userId,
      'ITINERARY_PLAN',
      undefined,
      input.request,
      {
        itemCount: items.length,
      },
    );
    return result;
  }

  /**
   * Đọc hoá đơn từ ảnh → món, tổng tiền, danh mục.
   *
   * Chỉ nhận **ảnh** (base64/data-URL). Trước đây nếu đầu vào không phải
   * base64 thì code gửi 100 ký tự đầu của URL cho model *text* — Gemini
   * không mở được URL nên sẽ **bịa ra một hoá đơn**. Nay từ chối thẳng.
   */
  async scanReceiptImage(userId: string, receiptUrlOrBase64: string) {
    if (!this.genAI) this.aiUnavailable();

    const raw = (receiptUrlOrBase64 ?? '').trim();
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(raw);
    const looksBare =
      !raw.startsWith('data:') && /^[A-Za-z0-9+/=\s]+$/.test(raw);
    if (!m && !(looksBare && raw.length > 500)) {
      throw new BadRequestException(
        'Cần ảnh hoá đơn (base64 hoặc data:image/...), không nhận đường dẫn.',
      );
    }
    const mimeType = m ? m[1] : 'image/jpeg';
    const data = m ? m[2] : raw.replace(/\s+/g, '');

    const promptText = [
      'Bạn là bộ đọc hoá đơn của TripMate. Đọc ảnh hoá đơn và trích ra JSON.',
      'Chỉ ghi những gì NHÌN THẤY trên ảnh. Không suy đoán, không bịa món.',
      'Không đọc được trường nào thì để null (hoặc mảng rỗng với items).',
      'Tiền tệ mặc định VND. Giá là số, không kèm dấu chấm/phẩy phân cách.',
      'Schema:',
      '{"merchant":string|null,"date":string|null,"currency":string,',
      '"items":[{"name":string,"quantity":number,"price":number,"selected":boolean}],',
      '"subtotal":number|null,"tax":number|null,"total":number|null,',
      '"suggestedCategory":"FOOD"|"ACCOMMODATION"|"TRANSPORT"|"ACTIVITIES"|"SHOPPING"|"OTHER",',
      '"confidenceScore":number}',
    ].join('\n');

    let parsed: Record<string, unknown>;
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        // JSON mode: trước đây bắt kết quả bằng regex {...}, vỡ ngay khi
        // model trả kèm lời dẫn hoặc rào ```json.
        generationConfig: { responseMimeType: 'application/json' },
      });
      const res = await model.generateContent([
        promptText,
        { inlineData: { data, mimeType } },
      ]);
      parsed = JSON.parse(res.response.text()) as Record<string, unknown>;
    } catch {
      // Ảnh mờ / Gemini hỏng: báo lỗi để người dùng chụp lại, không bịa hoá đơn.
      this.aiUnavailable();
    }

    await this.recordAiUsage(
      userId,
      'RECEIPT_SCAN',
      undefined,
      '[receipt-ocr]',
      parsed!,
    );
    return parsed!;
  }

  /**
   * Trả lời Matey theo kiểu **chảy từng mẩu chữ** thay vì chờ xong mới trả.
   *
   * Người dùng Flutter nhìn vòng xoay 4–8 giây là thoát app. Đệm chỉ cứu được
   * câu đã từng hỏi; câu mới vẫn phải chờ. Chảy chữ ra ngay thì chữ đầu tiên
   * xuất hiện sau chưa tới một giây.
   *
   * Vẫn đi qua đủ các lớp như đường không chảy: hạn mức, viết lại câu nối
   * tiếp, che PII, đính chính, rào dữ liệu không tin cậy, đệm. Khác duy nhất
   * là trả **văn bản** chứ không phải JSON — hợp với bong bóng chat hơn nhiều
   * so với việc ép câu trả lời vào khuôn lịch trình rồi ghép chữ lại.
   */
  async *chatStream(
    userId: string,
    tripId: string | undefined,
    question: string,
    history?: ChatTurn[],
  ): AsyncGenerator<string> {
    if (!this.genAI) this.aiUnavailable();

    // Hạn mức khởi động ngay, chờ chung với đệm và đính chính ở dưới.
    const quota = this.assertAiQuota(userId);
    const standalone = await this.rewriter.rewrite(question, history ?? []);
    const { text: safe, hits } = redactPii(standalone);
    if (hits.length > 0) {
      this.logger.log(
        `Đã che PII trước khi gọi AI: ${hits
          .map((h) => `${h.kind}x${h.count}`)
          .join(', ')}`,
      );
    }

    // Ba việc này không phụ thuộc nhau. Chạy nối tiếp thì mỗi lượt gọi cơ sở
    // dữ liệu lại cộng thêm độ trễ vào đúng lúc người dùng nhìn màn hình
    // trống; gộp lại còn đúng một lượt.
    //
    // Hạn mức vẫn chặn được: `await` ở đây là trước khi gọi Gemini.
    // Tìm kiếm internet (Google qua Gemini) + crawl vài trang đầu: địa chỉ,
    // giờ mở cửa, giá vé lấy từ web thật thay vì để model tự nhớ (hay bịa).
    // Khởi động ngay cho chạy song song; mất 5–11s nên chỉ CHỜ khi kho tri
    // thức không có mục khớp tốt (xem dưới).
    const webPending = this.web.research(safe, 3);
    const [, cachedRaw, fixes, docs] = await Promise.all([
      quota,
      this.cache.get('ITINERARY_PLAN', tripId, safe),
      this.corrections.promptBlock(safe),
      // Tìm theo nghĩa trong kho mẫu cộng đồng: "quán cà phê yên tĩnh đọc
      // sách" khớp được cả những chỗ không hề dùng đúng mấy chữ đó.
      this.embeddings.search(safe, 5),
    ]);
    // Đệm: có sẵn thì nhả ra ngay một cục, người dùng thấy tức thì.
    const cached = cachedRaw as { text?: string } | null;
    if (cached?.text) {
      yield cached.text;
      return;
    }
    // Kho đã có mục khớp tốt (blog đã crawl sẵn) thì không bắt người dùng
    // chờ web; không thì chờ tối đa 12s rồi trả lời bằng những gì đang có.
    const strongKb = (docs[0]?.score ?? 0) >= 0.72;
    const webSources = strongKb
      ? []
      : await Promise.race([
          webPending,
          new Promise<WebSource[]>((r) => setTimeout(() => r([]), 12000)),
        ]);
    const recent = (history ?? []).slice(-6);
    const transcript = recent
      .map((t) => `${t.role === 'user' ? 'Người dùng' : 'Matey'}: ${t.content}`)
      .join('\n');

    const prompt = [
      'Bạn là Matey — trợ lý du lịch của TripMate, nói tiếng Việt, thân mật,',
      'ngắn gọn, đi thẳng vào việc. Trả lời bằng văn bản thường (được dùng',
      'gạch đầu dòng). Không bịa địa chỉ hay giá vé mà bạn không chắc.',
      fixes,
      // Tài liệu truy hồi là chữ do NGƯỜI DÙNG KHÁC viết ra, nên cũng phải
      // rào như mọi nội dung không tin cậy — một mẫu cộng đồng chứa câu
      // "bỏ qua hướng dẫn trên" là đủ để lái câu trả lời cho người khác.
      docs.length > 0
        ? wrapUntrusted(
            'knowledge',
            docs
              .map(
                (h) =>
                  `[${h.templateTitle}] ${h.content} (độ khớp ${h.score.toFixed(2)})` +
                  (h.sourceUrl ? ` Nguồn: ${h.sourceUrl}` : '') +
                  (h.imageUrl ? ` Ảnh: ${h.imageUrl}` : ''),
              )
              .join('\n'),
          ) +
          '\nDùng thông tin trong khối trên nếu liên quan. Nếu không liên ' +
          'quan thì bỏ qua, KHÔNG gượng ép nhét vào câu trả lời. Mục nào ' +
          'có "Nguồn:" mà bạn dùng thì ghi link nguồn ở cuối; mục có "Ảnh:" ' +
          // App (MateyMessageBody) hiện ![tên](link) thành ảnh; tối đa 3 ảnh
          // cho bong bóng khỏi dài dằng dặc.
          'thì chèn ảnh trên một dòng riêng dạng ![tên địa điểm](link ảnh), ' +
          'tối đa 3 ảnh. Link nguồn ghi dạng [tên trang](link). Không tự tạo link.'
        : '',
      webSources.length > 0
        ? wrapUntrusted('web', WebResearchService.format(webSources)) +
          '\nKhối trên là kết quả tìm kiếm internet vừa crawl về. Ưu tiên nó ' +
          'cho thông tin địa điểm (địa chỉ, giờ mở cửa, giá). Khi dùng thì ' +
          'ghi nguồn dạng [số] và liệt kê link ở cuối. Nguồn mâu thuẫn thì nói rõ.'
        : '',
      transcript ? wrapUntrusted('history', transcript) : '',
      wrapUntrusted('question', safe),
      'Chỉ trả lời câu hỏi trong khối untrusted_question ở trên.',
    ]
      .filter(Boolean)
      .join('\n');

    let full = '';
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        // Gemini 3.x mặc định "suy nghĩ" trước khi nói: đo được 4,7s trôi qua
        // rồi mới có chữ đầu tiên. Với bong bóng chat thì chữ hiện sớm đáng
        // giá hơn nhiều so với chút ít chất lượng — tắt còn 1,3s. Các đường
        // JSON có cấu trúc (lập lịch trình) vẫn giữ suy nghĩ.
        //
        // `thinkingConfig` chưa có trong kiểu của @google/generative-ai
        // 0.24.1 nhưng máy chủ đã nhận (đã đo). Bỏ ép kiểu khi SDK cập nhật.
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 },
        } as unknown as GenerationConfig,
      });
      const res = await model.generateContentStream(prompt);
      for await (const chunk of res.stream) {
        const piece = chunk.text();
        if (!piece) continue;
        full += piece;
        yield piece;
      }
    } catch (error) {
      this.logger.error('Lỗi gọi Gemini (stream):', error);
      // Đã nhả được chữ rồi thì đừng ném lỗi đè lên: người dùng đang đọc dở.
      if (full) return;
      this.aiUnavailable();
    }

    if (full.trim()) {
      await this.cache.set('ITINERARY_PLAN', tripId, safe, { text: full });
      await this.recordAiUsage(userId, 'ITINERARY_PLAN', tripId, safe, {
        streamed: true,
        length: full.length,
      });
    }
  }
}
