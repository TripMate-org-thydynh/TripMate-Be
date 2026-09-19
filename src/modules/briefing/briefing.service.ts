import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { ItineraryWeatherService } from '../itineraries/itinerary-weather.service';

export interface MorningBrief {
  tripId: string;
  tripName: string;
  /** Ngày thứ mấy của chuyến (1-based). */
  day: number;
  date: string;
  weather: {
    weatherCode: number | null;
    tempMin: number | null;
    tempMax: number | null;
    rainProbability: number | null;
  } | null;
  stops: {
    id: string;
    startTime: string;
    placeName: string;
    rainRisk: number | null;
  }[];
  todos: {
    id: string;
    title: string;
    assigneeName: string | null;
    priority: string;
  }[];
  /** Câu tóm tắt một dòng — dùng làm nội dung thông báo. */
  summary: string;
}

/** Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD. */
export function todayVN(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Bản tin sáng cho chuyến đang diễn ra: thời tiết + các điểm hôm nay + việc
 * cần làm hôm nay và ai phụ trách.
 *
 * Gửi lúc 7:00 giờ Việt Nam vào hộp thông báo của từng thành viên. Mỗi người
 * mỗi chuyến mỗi ngày đúng MỘT bản — cron chạy lại (khởi động lại server, nhiều
 * instance) không gửi trùng.
 */
@Injectable()
export class BriefingService {
  private readonly logger = new Logger(BriefingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly weather: ItineraryWeatherService,
  ) {}

  async buildForTrip(tripId: string, date = todayVN()): Promise<MorningBrief> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId, deletedAt: null },
      select: { id: true, name: true, startDate: true, endDate: true },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    const start = trip.startDate.toISOString().slice(0, 10);
    const day =
      Math.round((Date.parse(date) - Date.parse(start)) / 86400_000) + 1;

    const [items, todos, wx] = await Promise.all([
      this.prisma.itineraryItem.findMany({
        where: { tripId, day },
        orderBy: { startTime: 'asc' },
        select: { id: true, startTime: true, placeName: true },
      }),
      // Việc hạn hôm nay, hoặc quá hạn mà chưa xong.
      this.prisma.todoItem.findMany({
        where: {
          tripId,
          isDone: false,
          dueDate: { lte: new Date(`${date}T23:59:59+07:00`) },
        },
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        take: 8,
        select: {
          id: true,
          title: true,
          priority: true,
          assignee: { select: { name: true } },
        },
      }),
      this.weather.forTrip(tripId).catch(() => null),
    ]);

    const w = wx?.days.find((d) => d.day === day && d.available) ?? null;
    const risk = new Map(
      (wx?.alerts ?? [])
        .filter((a) => a.day === day)
        .map((a) => [a.itemId, a.rainProbability]),
    );

    const parts: string[] = [];
    if (w?.tempMin != null && w.tempMax != null) {
      parts.push(`${Math.round(w.tempMin)}–${Math.round(w.tempMax)}°C`);
    }
    if (w?.rainProbability != null && w.rainProbability >= 50) {
      parts.push(`mưa ${w.rainProbability}%`);
    }
    if (items.length) {
      parts.push(
        `${items.length} điểm, bắt đầu ${items[0].startTime} ở ${items[0].placeName}`,
      );
    }
    if (todos.length) parts.push(`${todos.length} việc cần làm`);

    return {
      tripId,
      tripName: trip.name,
      day,
      date,
      weather: w
        ? {
            weatherCode: w.weatherCode ?? null,
            tempMin: w.tempMin ?? null,
            tempMax: w.tempMax ?? null,
            rainProbability: w.rainProbability ?? null,
          }
        : null,
      stops: items.map((i) => ({ ...i, rainRisk: risk.get(i.id) ?? null })),
      todos: todos.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        assigneeName: t.assignee?.name ?? null,
      })),
      summary: parts.join(' · ') || 'Hôm nay chưa có điểm nào trong lịch trình',
    };
  }

  /** 7:00 sáng giờ Việt Nam mỗi ngày. */
  @Cron('0 7 * * *', { name: 'morning-brief', timeZone: 'Asia/Ho_Chi_Minh' })
  async sendMorningBriefs() {
    const sent = await this.sendAll();
    this.logger.log(`Ban tin sang: da gui ${sent} thong bao`);
  }

  /** Gửi bản tin cho mọi chuyến đang diễn ra hôm nay. Trả số thông báo đã tạo. */
  async sendAll(date = todayVN()): Promise<number> {
    const day = new Date(`${date}T00:00:00Z`);
    const trips = await this.prisma.trip.findMany({
      where: {
        deletedAt: null,
        startDate: { lte: day },
        endDate: { gte: day },
      },
      select: { id: true, members: { select: { userId: true } } },
    });

    let sent = 0;
    for (const t of trips) {
      try {
        const brief = await this.buildForTrip(t.id, date);
        for (const m of t.members) {
          if (await this.alreadySent(m.userId, t.id, date)) continue;
          await this.prisma.notification.create({
            data: {
              userId: m.userId,
              tripId: t.id,
              type: 'TRIP_UPDATE',
              title: `Ngày ${brief.day} · ${brief.tripName}`,
              body: brief.summary,
              data: {
                kind: 'MORNING_BRIEF',
                tripId: t.id,
                date,
                day: brief.day,
              },
            },
          });
          sent++;
        }
      } catch (e) {
        this.logger.warn(`Ban tin chuyen ${t.id} loi: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async alreadySent(userId: string, tripId: string, date: string) {
    const hit = await this.prisma.notification.findFirst({
      where: {
        userId,
        tripId,
        data: { path: ['kind'], equals: 'MORNING_BRIEF' },
        AND: { data: { path: ['date'], equals: date } },
      },
      select: { id: true },
    });
    return !!hit;
  }
}
