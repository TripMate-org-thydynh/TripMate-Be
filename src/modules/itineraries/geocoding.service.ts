import { Injectable, Logger } from '@nestjs/common';
import { LruMap } from '../../common/utils/lru-map';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Đổi tên/địa chỉ điểm dừng thành toạ độ qua Nominatim (OpenStreetMap).
 *
 * Chính sách Nominatim: tối đa 1 request/giây, bắt buộc User-Agent. Service tự
 * xếp hàng các lượt gọi để không vượt nhịp đó, và nhớ cả kết quả "không tìm
 * thấy" để không hỏi lại cùng một chuỗi.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  // Có trần: tên địa điểm gần như vô hạn, Map thường làm server chạy lâu phình RAM.
  private readonly cache = new LruMap<string, GeoPoint | null>(5000);
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  /** Thử lần lượt: "tên, địa chỉ" → "địa chỉ" → "tên". */
  async locate(
    placeName: string,
    placeAddress?: string | null,
  ): Promise<GeoPoint | null> {
    const name = placeName?.trim() ?? '';
    const addr = placeAddress?.trim() ?? '';
    const candidates = [
      name && addr ? `${name}, ${addr}` : '',
      addr,
      name,
    ].filter((q, i, all) => q && all.indexOf(q) === i);

    for (const q of candidates) {
      const hit = await this.search(q);
      if (hit) return hit;
    }
    return null;
  }

  private search(query: string): Promise<GeoPoint | null> {
    const key = query.toLowerCase();
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key)!);

    const run = async () => {
      if (this.cache.has(key)) return this.cache.get(key)!;
      const wait = this.lastCall + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      try {
        const url =
          'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1' +
          `&accept-language=vi&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'TripMate/1.0 (travel app)' },
        });
        if (!res.ok) return null; // lỗi tạm thời: không nhớ, lần sau thử lại
        const data = (await res.json()) as { lat?: string; lon?: string }[];
        const first = data[0];
        const point =
          first?.lat && first?.lon
            ? { latitude: Number(first.lat), longitude: Number(first.lon) }
            : null;
        this.cache.set(key, point);
        return point;
      } catch (e) {
        this.logger.warn(
          `Nominatim loi voi "${query}": ${(e as Error).message}`,
        );
        return null;
      }
    };

    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
