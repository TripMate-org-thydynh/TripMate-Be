import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AIRequestType, AIStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as exifr from 'exifr';

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

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
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

  private queueItems: QueueItem[] = [
    {
      id: 'q-1',
      task: 'Tổng hợp video kỷ niệm Kyoto Matsuri 🎥',
      progress: 65,
      status: 'PROCESSING',
    },
    {
      id: 'q-2',
      task: 'Phân tích hóa đơn lẩu gà lá é 💸',
      progress: 100,
      status: 'COMPLETED',
    },
  ];

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
        model: 'gemini-2.5-flash',
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
  async photoLocation(imageBase64: string, mimeType: string) {
    const clean = imageBase64.includes(',')
      ? imageBase64.split(',').pop()!
      : imageBase64;
    const buffer = Buffer.from(clean, 'base64');

    // ── 1. EXIF GPS ────────────────────────────────────────────────────────
    try {
      const gps = await exifr.gps(buffer);
      if (
        gps &&
        typeof gps.latitude === 'number' &&
        typeof gps.longitude === 'number'
      ) {
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
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' },
      });
      const prompt =
        'Bạn là chuyên gia nhận diện địa danh. Nhìn ảnh và đoán nơi chụp. ' +
        'Chỉ trả JSON: {"found": boolean, "placeName": string (tên địa điểm/thành phố/quốc gia, tiếng Việt nếu được), ' +
        '"latitude": number, "longitude": number, "confidence": number (0..1)}. ' +
        'Nếu không đủ manh mối, found=false.';
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: clean } },
      ]);
      const parsed = JSON.parse(result.response.text()) as {
        found: boolean;
        placeName?: string;
        latitude?: number;
        longitude?: number;
        confidence?: number;
      };
      if (parsed.found && typeof parsed.latitude === 'number') {
        return {
          source: 'ai',
          found: true,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          placeName: parsed.placeName ?? 'Địa điểm (AI đoán)',
          confidence: parsed.confidence ?? 0.5,
        };
      }
      return {
        source: 'ai',
        found: false,
        message: 'Không nhận ra địa điểm từ ảnh.',
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
    imageBase64: string,
    mimeType: string,
  ): Promise<ParsedReservation[]> {
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
        model: 'gemini-2.5-flash',
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

  async createRequest(
    userId: string,
    tripId: string | undefined,
    type: AIRequestType,
    prompt: string,
  ) {
    let response: object | undefined = undefined;
    let status: AIStatus = 'COMPLETED';

    if (type === 'VIBE_MATCH') {
      {
        const promptText = `
          You are TripMate AI, a trendy, cool Gen Z travel vibe matcher.
          Analyze the vibe match between the following prompt/location and a squad's travel vibe.
          Prompt: "${prompt}"
          
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
          Roast the squad's spendings or the following prompt: "${prompt}".
          
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
          Create a detailed, beautiful travel itinerary based on this prompt: "${prompt}".
          
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
          Generate 3-5 creative, trendy, and funny Instagram/TikTok captions in Vietnamese (some with English hybrid/slang, emojis) based on this prompt/photos vibe: "${prompt}".
          
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
          Provide weather advice and packing tips based on the destination/time in this prompt: "${prompt}".
          
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
          Suggest 3 beautiful travel destinations matching this vibe/prompt: "${prompt}".
          
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
          Prompt: "${prompt}"
          
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
          Prompt: "${prompt}"
          
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

  async getPersonalityRoast(tripId: string) {
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
      return { tripId, squadAnalysis: result.squadAnalysis ?? [] };
    }
  }

  async getSquadMood(tripId: string) {
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
      return {
        tripId,
        overallMood: result.overallMood,
        tensionLevel: result.tensionLevel,
        moodAnalysis: result.moodAnalysis,
      };
    }
  }

  async getRecommendationTimeline(tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    {
      const promptText = `
        You are TripMate AI, the squad's personalized smart itinerary planner.
        Generate a recommended 2-item timeline for a day of their trip based on the trip details.
        
        Trip Name: "${trip.name}"
        Trip Destination/Description: "${trip.description || 'No description provided'}"
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
        
        Ensure the output is exactly a valid JSON array matching the schema!
      `;
      return await this.callGeminiJSON<RecommendedActivity[]>(promptText);
    }
  }

  getSavedPrompts() {
    return this.savedPromptsList;
  }

  getGenerationQueue() {
    return this.queueItems;
  }

  async scanReceiptImage(receiptUrlOrBase64: string) {
    if (!this.genAI) this.aiUnavailable();

    try {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
      });
      const promptText = `
        You are an expert OCR receipt parser for TripMate. Extract merchant name, total price, currency, category (FOOD, ACCOMMODATION, TRANSPORT, ACTIVITIES, SHOPPING, OTHER), and list of items with their names and prices.
        Return JSON matching this schema:
        {
          "merchant": string,
          "date": string,
          "items": Array<{ "name": string, "quantity": number, "price": number, "selected": boolean }>,
          "subtotal": number,
          "tax": number,
          "total": number,
          "suggestedCategory": string,
          "confidenceScore": number
        }
      `;

      if (
        receiptUrlOrBase64.startsWith('data:image/') ||
        receiptUrlOrBase64.length > 500
      ) {
        // Base64 Vision call
        const base64Data = receiptUrlOrBase64.replace(
          /^data:image\/\w+;base64,/,
          '',
        );
        const imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: 'image/jpeg',
          },
        };
        const res = await model.generateContent([promptText, imagePart]);
        const text = res.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        }
      }

      return await this.callGeminiJSON(
        promptText + ` Input: ${receiptUrlOrBase64.substring(0, 100)}`,
      );
    } catch {
      // Ảnh mờ / Gemini hỏng: báo lỗi để người dùng chụp lại, không bịa hoá đơn.
      this.aiUnavailable();
    }
  }
}
