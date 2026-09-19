import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';

export interface DayWeather {
  day: number;
  /** YYYY-MM-DD theo giờ Việt Nam. */
  date: string;
  /** false khi ngày nằm ngoài 16 ngày dự báo, hoặc chuyến chưa có toạ độ. */
  available: boolean;
  weatherCode?: number;
  tempMin?: number;
  tempMax?: number;
  /** Xác suất mưa cao nhất trong ngày (%). */
  rainProbability?: number;
}

export interface RainAlert {
  itemId: string;
  day: number;
  startTime: string;
  placeName: string;
  /** Xác suất mưa cao nhất trong khung giờ ở điểm đó (%). */
  rainProbability: number;
}

export interface ItineraryWeather {
  location: { latitude: number; longitude: number } | null;
  days: DayWeather[];
  alerts: RainAlert[];
}

/** Ngưỡng coi là "có khả năng mưa" để cảnh báo điểm ngoài trời. */
export const RAIN_ALERT_THRESHOLD = 60;

// Chữ trong tên cho biết là chỗ TRONG NHÀ — ưu tiên hơn category (dữ liệu
// category thực tế không đáng tin: quán lẩu, tiệm cà phê vẫn là ATTRACTION).
const INDOOR_WORDS = [
  'quán',
  'tiệm',
  'nhà hàng',
  'cà phê',
  'cafe',
  'coffee',
  'kem',
  'lẩu',
  'bảo tàng',
  'museum',
  'khách sạn',
  'hotel',
  'homestay',
  'resort',
  'spa',
  'rạp',
  'cinema',
  'trung tâm thương mại',
  'mall',
  'bar',
  'pub',
];
const OUTDOOR_WORDS = [
  'đồi',
  'thác',
  'hồ',
  'núi',
  'đỉnh',
  'biển',
  'bãi',
  'chợ',
  'quảng trường',
  'vườn',
  'farm',
  'nông trại',
  'rừng',
  'đèo',
  'phố đi bộ',
  'công viên',
  'trekking',
  'cắm trại',
  'camping',
  'sup',
  'săn mây',
  'đảo',
  'suối',
  'hang',
];
const OUTDOOR_CATEGORIES = new Set([
  'ATTRACTION',
  'ACTIVITIES',
  'ADVENTURE',
  'NATURE',
  'SIGHTSEEING',
  'PLACE',
  'OUTDOOR',
]);

/** Điểm có ở ngoài trời không (để cảnh báo khi mưa). */
export function isOutdoor(placeName: string, category?: string | null) {
  const name = placeName.toLowerCase();
  if (OUTDOOR_WORDS.some((w) => name.includes(w))) return true;
  if (INDOOR_WORDS.some((w) => name.includes(w))) return false;
  return OUTDOOR_CATEGORIES.has((category ?? '').toUpperCase());
}

/** "08:30" → 8. Chuỗi lạ → null. */
function hourOf(startTime: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(startTime.trim());
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h < 24 ? h : null;
}

/** Ngày YYYY-MM-DD của (ngày bắt đầu chuyến + n ngày). */
function addDays(start: Date, n: number): string {
  const d = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + n,
    ),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * Dự báo thời tiết gắn với lịch trình: mỗi ngày của chuyến một dòng, cộng danh
 * sách cảnh báo "điểm ngoài trời vào giờ dễ mưa".
 *
 * Nguồn: Open-Meteo (miễn phí, không cần key, 16 ngày). Vị trí lấy là tâm các
 * điểm dừng có toạ độ — một chuyến thường gói trong một vùng.
 */
@Injectable()
export class ItineraryWeatherService {
  private readonly logger = new Logger(ItineraryWeatherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async forTrip(tripId: string): Promise<ItineraryWeather> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId, deletedAt: null },
      select: {
        startDate: true,
        endDate: true,
        itineraries: {
          select: {
            id: true,
            day: true,
            startTime: true,
            durationMinutes: true,
            placeName: true,
            category: true,
            latitude: true,
            longitude: true,
          },
          orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
        },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');

    const items = trip.itineraries;
    const located = items.filter(
      (i) => i.latitude != null && i.longitude != null,
    );
    const dayCount = Math.max(
      Math.round(
        (trip.endDate.getTime() - trip.startDate.getTime()) / 86400000,
      ) + 1,
      ...items.map((i) => i.day),
      1,
    );
    const days: DayWeather[] = Array.from({ length: dayCount }, (_, i) => ({
      day: i + 1,
      date: addDays(trip.startDate, i),
      available: false,
    }));
    if (located.length === 0) return { location: null, days, alerts: [] };

    const location = {
      latitude:
        located.reduce((s, i) => s + Number(i.latitude), 0) / located.length,
      longitude:
        located.reduce((s, i) => s + Number(i.longitude), 0) / located.length,
    };

    const forecast = await this.forecast(location.latitude, location.longitude);
    if (!forecast) return { location, days, alerts: [] };

    for (const d of days) {
      const idx = forecast.daily.time.indexOf(d.date);
      if (idx < 0) continue;
      d.available = true;
      d.weatherCode = forecast.daily.weather_code[idx];
      d.tempMin = forecast.daily.temperature_2m_min[idx];
      d.tempMax = forecast.daily.temperature_2m_max[idx];
      d.rainProbability = forecast.daily.precipitation_probability_max[idx];
    }

    // Xác suất mưa theo giờ, khoá "YYYY-MM-DDTHH".
    const hourly = new Map<string, number>();
    forecast.hourly.time.forEach((t, i) =>
      hourly.set(t.slice(0, 13), forecast.hourly.precipitation_probability[i]),
    );

    const alerts: RainAlert[] = [];
    for (const it of items) {
      if (!isOutdoor(it.placeName, it.category)) continue;
      const h = hourOf(it.startTime);
      const date = days[it.day - 1]?.date;
      if (h == null || !date) continue;
      // Xét cả khung giờ ở điểm đó, không chỉ giờ đến.
      const span = Math.max(1, Math.ceil(it.durationMinutes / 60));
      let worst = -1;
      for (let k = 0; k < span && h + k < 24; k++) {
        const p = hourly.get(`${date}T${String(h + k).padStart(2, '0')}`);
        if (p != null && p > worst) worst = p;
      }
      if (worst >= RAIN_ALERT_THRESHOLD) {
        alerts.push({
          itemId: it.id,
          day: it.day,
          startTime: it.startTime,
          placeName: it.placeName,
          rainProbability: worst,
        });
      }
    }
    return { location, days, alerts };
  }

  private async forecast(lat: number, lng: number) {
    // Làm tròn toạ độ ~1km để các chuyến cùng vùng dùng chung cache.
    const key = `weather:${lat.toFixed(2)}:${lng.toFixed(2)}`;
    try {
      const hit = await this.cache.get<OpenMeteo>(key);
      if (hit) return hit;
    } catch {
      /* cache chỉ là tối ưu */
    }
    try {
      const url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${lat}&longitude=${lng}` +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&hourly=precipitation_probability' +
        '&timezone=Asia%2FHo_Chi_Minh&forecast_days=16';
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as OpenMeteo;
      try {
        await this.cache.set(key, data, 30 * 60 * 1000);
      } catch {
        /* bỏ qua */
      }
      return data;
    } catch (e) {
      this.logger.warn(`Open-Meteo loi: ${(e as Error).message}`);
      return null;
    }
  }
}

interface OpenMeteo {
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
  hourly: { time: string[]; precipitation_probability: number[] };
}
