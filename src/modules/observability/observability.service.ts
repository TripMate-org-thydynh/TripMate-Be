import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Định nghĩa các bucket histogram thời gian phản hồi.
 *
 * LƯU Ý QUAN TRỌNG:
 * Trong cơ sở dữ liệu (`request_metrics`) và buffer in-memory, các cột `le*`
 * là SỐ ĐẾM RIÊNG BIỆT TỪNG Ô (non-cumulative), KHÔNG PHẢI tích luỹ kiểu Prometheus:
 * - le50:   <= 50ms ([0, 50])
 * - le100:  (50, 100]
 * - le250:  (100, 250]
 * - le500:  (250, 500]
 * - le1000: (500, 1000]
 * - le2500: (1000, 2500]
 * - le5000: (2500, 5000]
 * - leInf:  > 5000ms ((5000, +∞))
 *
 * Tầng đọc (service) tự cộng dồn trước khi tính toán phân vị hoặc SLO.
 */
export interface HistogramBuckets {
  le50: number;
  le100: number;
  le250: number;
  le500: number;
  le1000: number;
  le2500: number;
  le5000: number;
  leInf: number;
}

/**
 * Thẻ tổng quan hiệu năng hệ thống cho một khoảng thời gian.
 */
export interface OverviewResult {
  rangeMinutes: number;
  totalRequests: number;
  rps: number;
  errorRatePercent: number;
  clientErrorRatePercent: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

/**
 * Điểm dữ liệu theo chuỗi thời gian cho biểu đồ.
 */
export interface TimeseriesPoint {
  ts: string;
  requests: number;
  errors5xx: number;
  errors4xx: number;
  errorRatePercent: number;
  p95Ms: number;
  avgLatencyMs: number;
}

/**
 * Số liệu hiệu năng gộp theo từng route.
 */
export interface RouteMetricResult {
  route: string;
  method: string;
  requests: number;
  errors5xx: number;
  errors4xx: number;
  errorRatePercent: number;
  p95Ms: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

/**
 * Kết quả đánh giá trạng thái SLO và ngân sách lỗi (Error Budget).
 */
export interface SloEvaluationResult {
  id: string;
  key: string;
  name: string;
  sliType: string;
  objective: number;
  windowDays: number;
  latencyThresholdMs: number | null;
  routePrefix: string | null;
  totalEvents: number;
  goodEvents: number;
  badEvents: number;
  currentSliPercent: number | null;
  isMeetingObjective: boolean;
  errorBudgetTotal: number;
  errorBudgetConsumed: number;
  errorBudgetRemainingPercent: number;
  burnRate: number;
}

export interface CreateSloTargetParams {
  key: string;
  name: string;
  sliType: 'AVAILABILITY' | 'LATENCY';
  objective: number;
  windowDays?: number;
  latencyThresholdMs?: number;
  routePrefix?: string | null;
  isActive?: boolean;
}

export interface UpdateSloTargetParams {
  key?: string;
  name?: string;
  sliType?: 'AVAILABILITY' | 'LATENCY';
  objective?: number;
  windowDays?: number;
  latencyThresholdMs?: number | null;
  routePrefix?: string | null;
  isActive?: boolean;
}

@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Truy cập delegate RequestMetric từ Prisma.
   * Dùng cú pháp (this.prisma as any) để an toàn trước khi `npx prisma generate` được chạy lại.
   */
  private get requestMetricRepo() {
    return (this.prisma as any).requestMetric;
  }

  /**
   * Truy cập delegate SloTarget từ Prisma.
   */
  private get sloTargetRepo() {
    return (this.prisma as any).sloTarget;
  }

  private ensureRequestMetricRepo() {
    const repo = this.requestMetricRepo;
    if (!repo) {
      this.logger.error(
        'Prisma delegate RequestMetric chưa sẵn sàng. Cần chạy `npx prisma generate`.',
      );
      throw new BadRequestException(
        'Prisma delegate RequestMetric chưa sẵn sàng. Hãy chạy npx prisma generate.',
      );
    }
    return repo;
  }

  private ensureSloTargetRepo() {
    const repo = this.sloTargetRepo;
    if (!repo) {
      this.logger.error(
        'Prisma delegate SloTarget chưa sẵn sàng. Cần chạy `npx prisma generate`.',
      );
      throw new BadRequestException(
        'Prisma delegate SloTarget chưa sẵn sàng. Hãy chạy npx prisma generate.',
      );
    }
    return repo;
  }

  /**
   * Tính phân vị (pN: p50, p95, p99...) từ histogram bằng phương pháp nội suy tuyến tính.
   *
   * LƯU Ý ĐẶC TẢ QUAN TRỌNG (TRÁNH SỬA NHẦM):
   * Các cột `le*` trong database (`request_metrics`) và interface `HistogramBuckets`
   * là SỐ ĐẾM RIÊNG BIỆT TỪNG Ô (non-cumulative), KHÔNG PHẢI tích luỹ kiểu Prometheus.
   * Tầng ghi (`metrics-buffer.service.ts`) chỉ tăng ĐÚNG MỘT bucket cho mỗi request:
   * - le50:   số request có latency <= 50ms ([0, 50])
   * - le100:  số request trong khoảng (50, 100]
   * - le250:  trong khoảng (100, 250]
   * - le500:  (250, 500]
   * - le1000: (500, 1000]
   * - le2500: (1000, 2500]
   * - le5000: (2500, 5000]
   * - leInf:  > 5000ms ((5000, +∞))
   *
   * Hàm này TỰ CỘNG DỒN các ô thành mảng tích luỹ trước khi tìm phân vị và nội suy tuyến tính:
   * 1. Tổng số request = tổng tất cả các bucket (le50 + le100 + ... + leInf).
   * 2. Vị trí rank = (percentile / 100) * total.
   * 3. Duyệt qua các khoảng theo thứ tự tăng dần để tìm ô đầu tiên có count_tích_luỹ >= rank.
   * 4. Cận của các ô lần lượt là: [0,50], (50,100], (100,250], (250,500], (500,1000], (1000,2500], (2500,5000], (5000,∞).
   * 5. Nội suy tuyến tính trong ô tìm được giữa cận dưới (lower) và cận trên (upper) của chính ô đó:
   *    fraction = (rank - prevCumulative) / countInBucket
   *    interpolated = lower + (upper - lower) * fraction
   * 6. Ô cuối cùng `leInf` (> 5000ms) không có cận trên hữu hạn:
   *    -> Trả về 5000ms (cận dưới của nó) làm giá trị chặn dưới an toàn, không ước lượng ảo.
   */
  percentileFromHistogram(
    buckets: HistogramBuckets,
    percentile: number,
  ): number {
    const b50 = Math.max(0, buckets?.le50 || 0);
    const b100 = Math.max(0, buckets?.le100 || 0);
    const b250 = Math.max(0, buckets?.le250 || 0);
    const b500 = Math.max(0, buckets?.le500 || 0);
    const b1000 = Math.max(0, buckets?.le1000 || 0);
    const b2500 = Math.max(0, buckets?.le2500 || 0);
    const b5000 = Math.max(0, buckets?.le5000 || 0);
    const bInf = Math.max(0, buckets?.leInf || 0);

    const total =
      b50 + b100 + b250 + b500 + b1000 + b2500 + b5000 + bInf;

    if (total <= 0 || percentile <= 0) {
      return 0;
    }

    const rank = Math.min(total, (percentile / 100) * total);

    const intervals: Array<{ lower: number; upper: number; count: number }> = [
      { lower: 0, upper: 50, count: b50 },
      { lower: 50, upper: 100, count: b100 },
      { lower: 100, upper: 250, count: b250 },
      { lower: 250, upper: 500, count: b500 },
      { lower: 500, upper: 1000, count: b1000 },
      { lower: 1000, upper: 2500, count: b2500 },
      { lower: 2500, upper: 5000, count: b5000 },
      { lower: 5000, upper: Infinity, count: bInf },
    ];

    let cumulativeCount = 0;
    for (const interval of intervals) {
      const prevCount = cumulativeCount;
      cumulativeCount += interval.count;

      if (cumulativeCount >= rank) {
        if (!Number.isFinite(interval.upper)) {
          // BẪY PHÂN VỊ: Ô cuối (> 5000ms / leInf) không có cận trên hữu hạn.
          // Trả về 5000ms (cận dưới của ô) làm chặn dưới an toàn, không phải giá trị đo tuyệt đối.
          return 5000;
        }

        const countInBucket = interval.count;
        if (countInBucket <= 0) {
          return interval.lower;
        }

        const fraction = (rank - prevCount) / countInBucket;
        const interpolated =
          interval.lower + (interval.upper - interval.lower) * fraction;
        return Math.round(interpolated * 100) / 100;
      }
    }

    // Nếu do sai số làm tròn số thực mà chưa chạm điều kiện, chặn dưới an toàn là 5000
    return 5000;
  }

  /**
   * Tính số request đạt chuẩn độ trễ (nhanh hơn latencyThresholdMs) cho SLO kiểu LATENCY.
   *
   * LƯU Ý ĐẶC TẢ QUAN TRỌNG (TRÁNH SỬA NHẦM):
   * Các cột `le*` trong HistogramBuckets là SỐ ĐẾM RIÊNG BIỆT TỪNG Ô (không tích luỹ kiểu Prometheus).
   * Hàm này TỰ CỘNG DỒN thành các mốc tích luỹ trước khi tính good events:
   * - c50:   <= 50ms
   * - c100:  <= 100ms (c50 + le100)
   * - c250:  <= 250ms (c100 + le250)
   * - c500:  <= 500ms (c250 + le500)
   * - c1000: <= 1000ms (c500 + le1000)
   * - c2500: <= 2500ms (c1000 + le2500)
   * - c5000: <= 5000ms (c2500 + le5000)
   * - total: tổng toàn bộ request (c5000 + leInf)
   *
   * Quy tắc:
   * 1. Nếu latencyThresholdMs khớp đúng một trong các mốc có sẵn (50, 100, 250, 500, 1000, 2500, 5000),
   *    lấy giá trị tích luỹ tại mốc đó.
   * 2. Nếu không khớp mốc nào (ví dụ latencyThresholdMs = 300ms), nội suy tuyến tính giữa 2 mốc gần nhất.
   * 3. Với latencyThresholdMs > 5000ms: do vượt qua mốc hữu hạn lớn nhất, chặn an toàn ở c5000.
   */
  calculateLatencyGoodCount(
    buckets: HistogramBuckets,
    latencyThresholdMs: number,
  ): number {
    if (latencyThresholdMs <= 0) {
      return 0;
    }

    const b50 = Math.max(0, buckets?.le50 || 0);
    const b100 = Math.max(0, buckets?.le100 || 0);
    const b250 = Math.max(0, buckets?.le250 || 0);
    const b500 = Math.max(0, buckets?.le500 || 0);
    const b1000 = Math.max(0, buckets?.le1000 || 0);
    const b2500 = Math.max(0, buckets?.le2500 || 0);
    const b5000 = Math.max(0, buckets?.le5000 || 0);
    const bInf = Math.max(0, buckets?.leInf || 0);

    // Tự cộng dồn thành các mốc tích luỹ
    const c50 = b50;
    const c100 = c50 + b100;
    const c250 = c100 + b250;
    const c500 = c250 + b500;
    const c1000 = c500 + b1000;
    const c2500 = c1000 + b2500;
    const c5000 = c2500 + b5000;
    const total = c5000 + bInf;

    if (total <= 0) {
      return 0;
    }

    // 1. Khớp chính xác các mốc tích luỹ
    switch (latencyThresholdMs) {
      case 50:
        return c50;
      case 100:
        return c100;
      case 250:
        return c250;
      case 500:
        return c500;
      case 1000:
        return c1000;
      case 2500:
        return c2500;
      case 5000:
        return c5000;
    }

    // Nếu ngưỡng lớn hơn 5000ms: xấp xỉ an toàn bằng c5000 vì ngoài 5000ms không có cận trên xác định
    if (latencyThresholdMs > 5000) {
      return c5000;
    }

    // 2. Nội suy giữa hai mốc gần nhất
    const points: Array<{ ms: number; count: number }> = [
      { ms: 0, count: 0 },
      { ms: 50, count: c50 },
      { ms: 100, count: c100 },
      { ms: 250, count: c250 },
      { ms: 500, count: c500 },
      { ms: 1000, count: c1000 },
      { ms: 2500, count: c2500 },
      { ms: 5000, count: c5000 },
    ];

    for (let i = 0; i < points.length - 1; i++) {
      const pLow = points[i];
      const pHigh = points[i + 1];
      if (latencyThresholdMs >= pLow.ms && latencyThresholdMs <= pHigh.ms) {
        const span = pHigh.ms - pLow.ms;
        if (span <= 0) return pLow.count;
        const fraction = (latencyThresholdMs - pLow.ms) / span;
        // Nội suy tuyến tính xấp xỉ giữa 2 mốc
        const interpolated = pLow.count + (pHigh.count - pLow.count) * fraction;
        return Math.min(Math.round(interpolated), total);
      }
    }

    return Math.min(c5000, total);
  }

  /**
   * 1. GET /overview?rangeMinutes=60
   * Thẻ tổng quan hiệu năng hệ thống trong khoảng thời gian xác định.
   */
  async getOverview(rangeMinutes = 60): Promise<OverviewResult> {
    const repo = this.ensureRequestMetricRepo();
    const minutes = Math.max(1, rangeMinutes);
    const now = new Date();
    const startTime = new Date(now.getTime() - minutes * 60 * 1000);

    const records = await repo.findMany({
      where: {
        bucketStart: {
          gte: startTime,
          lte: now,
        },
      },
    });

    let totalRequests = 0;
    let errors5xx = 0;
    let errors4xx = 0;
    let totalSumLatencyMs = 0n;
    let maxLatencyMs = 0;
    const histogram: HistogramBuckets = {
      le50: 0,
      le100: 0,
      le250: 0,
      le500: 0,
      le1000: 0,
      le2500: 0,
      le5000: 0,
      leInf: 0,
    };

    for (const r of records) {
      totalRequests += r.count;
      if (r.statusClass === 5) errors5xx += r.count;
      if (r.statusClass === 4) errors4xx += r.count;

      // XỬ LÝ BIGINT: sumLatencyMs từ Postgres là kiểu BigInt.
      // Dùng phép toán BigInt để cộng dồn chính xác không tràn số.
      totalSumLatencyMs += BigInt(r.sumLatencyMs);

      if (r.maxLatencyMs > maxLatencyMs) {
        maxLatencyMs = r.maxLatencyMs;
      }
      histogram.le50 += r.le50;
      histogram.le100 += r.le100;
      histogram.le250 += r.le250;
      histogram.le500 += r.le500;
      histogram.le1000 += r.le1000;
      histogram.le2500 += r.le2500;
      histogram.le5000 += r.le5000;
      histogram.leInf += r.leInf;
    }

    if (totalRequests === 0) {
      return {
        rangeMinutes: minutes,
        totalRequests: 0,
        rps: 0,
        errorRatePercent: 0,
        clientErrorRatePercent: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
      };
    }

    const rangeSeconds = minutes * 60;
    const rps = Math.round((totalRequests / rangeSeconds) * 100) / 100;
    const errorRatePercent =
      Math.round((errors5xx / totalRequests) * 10000) / 100;
    const clientErrorRatePercent =
      Math.round((errors4xx / totalRequests) * 10000) / 100;

    // XỬ LÝ BIGINT: Ép sang Number(totalSumLatencyMs) trước khi chia và serialize JSON
    const avgLatencyMs =
      Math.round((Number(totalSumLatencyMs) / totalRequests) * 100) / 100;

    const p50Ms = this.percentileFromHistogram(histogram, 50);
    const p95Ms = this.percentileFromHistogram(histogram, 95);
    const p99Ms = this.percentileFromHistogram(histogram, 99);

    return {
      rangeMinutes: minutes,
      totalRequests,
      rps,
      errorRatePercent,
      clientErrorRatePercent,
      p50Ms,
      p95Ms,
      p99Ms,
      avgLatencyMs,
      maxLatencyMs,
    };
  }

  /**
   * 2. GET /timeseries?rangeMinutes=60&stepMinutes=1
   * Chuỗi thời gian cho biểu đồ, đảm bảo ĐẦY ĐỦ các mốc thời gian (điền 0 nếu không có request).
   */
  async getTimeseries(
    rangeMinutes = 60,
    stepMinutes = 1,
  ): Promise<TimeseriesPoint[]> {
    const repo = this.ensureRequestMetricRepo();
    const validRange = Math.max(1, rangeMinutes);
    const validStep = Math.max(1, stepMinutes);

    const stepMs = validStep * 60 * 1000;
    // Căn chỉnh mốc kết thúc theo bội số nguyên của step
    const alignedEndMs = Math.floor(Date.now() / stepMs) * stepMs;
    const numSteps = Math.max(1, Math.floor(validRange / validStep));
    const startMs = alignedEndMs - (numSteps - 1) * stepMs;
    const startTime = new Date(startMs);
    const endTime = new Date(alignedEndMs + stepMs);

    // BƯỚC QUAN TRỌNG: Khởi tạo trước ĐẦY ĐỦ mọi mốc thời gian trong khoảng.
    // Nếu mốc nào không có dữ liệu, các chỉ số sẽ mang giá trị 0.
    // Tránh việc biểu đồ nối chéo các điểm khiến người xem lầm tưởng hệ thống chạy bình thường.
    const slotBuckets: Array<{
      ts: string;
      requests: number;
      errors5xx: number;
      errors4xx: number;
      sumLatencyMs: bigint;
      histogram: HistogramBuckets;
    }> = [];

    for (let i = 0; i < numSteps; i++) {
      const slotTime = new Date(startMs + i * stepMs);
      slotBuckets.push({
        ts: slotTime.toISOString(),
        requests: 0,
        errors5xx: 0,
        errors4xx: 0,
        sumLatencyMs: 0n,
        histogram: {
          le50: 0,
          le100: 0,
          le250: 0,
          le500: 0,
          le1000: 0,
          le2500: 0,
          le5000: 0,
          leInf: 0,
        },
      });
    }

    const records = await repo.findMany({
      where: {
        bucketStart: {
          gte: startTime,
          lt: endTime,
        },
      },
    });

    for (const r of records) {
      const rTimeMs = new Date(r.bucketStart).getTime();
      const slotIndex = Math.floor((rTimeMs - startMs) / stepMs);
      if (slotIndex >= 0 && slotIndex < slotBuckets.length) {
        const slot = slotBuckets[slotIndex];
        slot.requests += r.count;
        if (r.statusClass === 5) slot.errors5xx += r.count;
        if (r.statusClass === 4) slot.errors4xx += r.count;
        // XỬ LÝ BIGINT: cộng dồn BigInt
        slot.sumLatencyMs += BigInt(r.sumLatencyMs);
        slot.histogram.le50 += r.le50;
        slot.histogram.le100 += r.le100;
        slot.histogram.le250 += r.le250;
        slot.histogram.le500 += r.le500;
        slot.histogram.le1000 += r.le1000;
        slot.histogram.le2500 += r.le2500;
        slot.histogram.le5000 += r.le5000;
        slot.histogram.leInf += r.leInf;
      }
    }

    return slotBuckets.map((slot) => {
      const requests = slot.requests;
      const errors5xx = slot.errors5xx;
      const errors4xx = slot.errors4xx;
      const errorRatePercent =
        requests > 0 ? Math.round((errors5xx / requests) * 10000) / 100 : 0;
      const p95Ms =
        requests > 0 ? this.percentileFromHistogram(slot.histogram, 95) : 0;
      // XỬ LÝ BIGINT: Ép Number(slot.sumLatencyMs) trước khi tính trung bình và trả về
      const avgLatencyMs =
        requests > 0
          ? Math.round((Number(slot.sumLatencyMs) / requests) * 100) / 100
          : 0;

      return {
        ts: slot.ts,
        requests,
        errors5xx,
        errors4xx,
        errorRatePercent,
        p95Ms,
        avgLatencyMs,
      };
    });
  }

  /**
   * 3. GET /routes?rangeMinutes=60&limit=20&sortBy=requests|errors|latency
   * Thống kê chi tiết theo route pattern và HTTP method.
   */
  async getRoutes(
    rangeMinutes = 60,
    limit = 20,
    sortBy: 'requests' | 'errors' | 'latency' = 'requests',
  ): Promise<RouteMetricResult[]> {
    const repo = this.ensureRequestMetricRepo();
    const minutes = Math.max(1, rangeMinutes);
    const startTime = new Date(Date.now() - minutes * 60 * 1000);

    const records = await repo.findMany({
      where: {
        bucketStart: {
          gte: startTime,
        },
      },
    });

    const groupMap = new Map<
      string,
      {
        route: string;
        method: string;
        requests: number;
        errors5xx: number;
        errors4xx: number;
        sumLatencyMs: bigint;
        maxLatencyMs: number;
        histogram: HistogramBuckets;
      }
    >();

    for (const r of records) {
      const key = `${r.route}###${r.method}`;
      let item = groupMap.get(key);
      if (!item) {
        item = {
          route: r.route,
          method: r.method,
          requests: 0,
          errors5xx: 0,
          errors4xx: 0,
          sumLatencyMs: 0n,
          maxLatencyMs: 0,
          histogram: {
            le50: 0,
            le100: 0,
            le250: 0,
            le500: 0,
            le1000: 0,
            le2500: 0,
            le5000: 0,
            leInf: 0,
          },
        };
        groupMap.set(key, item);
      }

      item.requests += r.count;
      if (r.statusClass === 5) item.errors5xx += r.count;
      if (r.statusClass === 4) item.errors4xx += r.count;
      // XỬ LÝ BIGINT
      item.sumLatencyMs += BigInt(r.sumLatencyMs);
      if (r.maxLatencyMs > item.maxLatencyMs) {
        item.maxLatencyMs = r.maxLatencyMs;
      }
      item.histogram.le50 += r.le50;
      item.histogram.le100 += r.le100;
      item.histogram.le250 += r.le250;
      item.histogram.le500 += r.le500;
      item.histogram.le1000 += r.le1000;
      item.histogram.le2500 += r.le2500;
      item.histogram.le5000 += r.le5000;
      item.histogram.leInf += r.leInf;
    }

    const results: RouteMetricResult[] = [];
    for (const item of groupMap.values()) {
      const requests = item.requests;
      const errors5xx = item.errors5xx;
      const errors4xx = item.errors4xx;
      const errorRatePercent =
        requests > 0 ? Math.round((errors5xx / requests) * 10000) / 100 : 0;
      const p95Ms =
        requests > 0 ? this.percentileFromHistogram(item.histogram, 95) : 0;
      // XỬ LÝ BIGINT: Ép Number(item.sumLatencyMs)
      const avgLatencyMs =
        requests > 0
          ? Math.round((Number(item.sumLatencyMs) / requests) * 100) / 100
          : 0;

      results.push({
        route: item.route,
        method: item.method,
        requests,
        errors5xx,
        errors4xx,
        errorRatePercent,
        p95Ms,
        avgLatencyMs,
        maxLatencyMs: item.maxLatencyMs,
      });
    }

    if (sortBy === 'errors') {
      results.sort(
        (a, b) => b.errors5xx - a.errors5xx || b.requests - a.requests,
      );
    } else if (sortBy === 'latency') {
      results.sort(
        (a, b) => b.p95Ms - a.p95Ms || b.avgLatencyMs - a.avgLatencyMs,
      );
    } else {
      results.sort(
        (a, b) => b.requests - a.requests || b.errors5xx - a.errors5xx,
      );
    }

    const maxItems = Math.max(1, limit);
    return results.slice(0, maxItems);
  }

  /**
   * 4. GET /slo
   * Tính toán tình trạng SLO và mức tiêu thụ Error Budget cho từng mục tiêu đang kích hoạt.
   */
  async getSloOverview(): Promise<SloEvaluationResult[]> {
    const sloRepo = this.ensureSloTargetRepo();
    const metricRepo = this.ensureRequestMetricRepo();

    const activeTargets = await sloRepo.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    const evaluations: SloEvaluationResult[] = [];

    for (const target of activeTargets) {
      const windowDays = target.windowDays || 30;
      const startTime = new Date(
        Date.now() - windowDays * 24 * 60 * 60 * 1000,
      );
      // XỬ LÝ DECIMAL: Ép Decimal từ Prisma sang Number
      const objective = Number(target.objective);

      const whereClause: any = {
        bucketStart: { gte: startTime },
      };
      if (target.routePrefix && target.routePrefix.trim().length > 0) {
        whereClause.route = { startsWith: target.routePrefix.trim() };
      }

      const records = await metricRepo.findMany({
        where: whereClause,
      });

      let totalEvents = 0;
      let goodEvents = 0;
      let badEvents = 0;

      if (target.sliType === 'AVAILABILITY') {
        /**
         * CHUẨN NGÀNH SRE (Google SRE Book - Chapter 4):
         * - badEvents: Chỉ tính các request có statusClass === 5 (lỗi 5xx máy chủ).
         * - goodEvents: Toàn bộ các request còn lại (2xx, 3xx, 4xx).
         *
         * GIẢI THÍCH CHI TIẾT:
         * Mã lỗi 4xx (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found...)
         * phát sinh do phía người dùng/client gửi dữ liệu không hợp lệ hoặc thiếu chứng thực.
         * Những lỗi này KHÔNG phải là lỗi của dịch vụ TripMate và hệ thống vẫn phản hồi đúng
         * theo thiết kế. Do đó, chuẩn ngành tuyệt đối KHÔNG trừ lỗi 4xx vào ngân sách lỗi
         * (Error Budget) của dịch vụ.
         */
        let count5xx = 0;
        for (const r of records) {
          totalEvents += r.count;
          if (r.statusClass === 5) {
            count5xx += r.count;
          }
        }
        badEvents = count5xx;
        goodEvents = Math.max(0, totalEvents - badEvents);
      } else {
        // SLI TYPE: LATENCY
        // goodEvents: Số request phản hồi nhanh hơn ngưỡng latencyThresholdMs (lấy từ histogram)
        // badEvents: totalEvents - goodEvents
        const threshold = target.latencyThresholdMs ?? 500;
        const aggHistogram: HistogramBuckets = {
          le50: 0,
          le100: 0,
          le250: 0,
          le500: 0,
          le1000: 0,
          le2500: 0,
          le5000: 0,
          leInf: 0,
        };

        for (const r of records) {
          totalEvents += r.count;
          aggHistogram.le50 += r.le50;
          aggHistogram.le100 += r.le100;
          aggHistogram.le250 += r.le250;
          aggHistogram.le500 += r.le500;
          aggHistogram.le1000 += r.le1000;
          aggHistogram.le2500 += r.le2500;
          aggHistogram.le5000 += r.le5000;
          aggHistogram.leInf += r.leInf;
        }

        goodEvents = this.calculateLatencyGoodCount(aggHistogram, threshold);
        if (goodEvents > totalEvents) {
          goodEvents = totalEvents;
        }
        badEvents = Math.max(0, totalEvents - goodEvents);
      }

      // XỬ LÝ ĐẶC BIỆT KHI CHƯA CÓ EVENT:
      // totalEvents === 0 -> currentSliPercent: null, burnRate: 0, isMeetingObjective: true.
      // Không chia cho 0.
      if (totalEvents === 0) {
        evaluations.push({
          id: target.id,
          key: target.key,
          name: target.name,
          sliType: target.sliType,
          objective,
          windowDays,
          latencyThresholdMs: target.latencyThresholdMs,
          routePrefix: target.routePrefix,
          totalEvents: 0,
          goodEvents: 0,
          badEvents: 0,
          currentSliPercent: null,
          isMeetingObjective: true,
          errorBudgetTotal: 0,
          errorBudgetConsumed: 0,
          errorBudgetRemainingPercent: 100,
          burnRate: 0,
        });
        continue;
      }

      const currentSliPercent =
        Math.round((goodEvents / totalEvents) * 10000) / 100;
      const isMeetingObjective = currentSliPercent >= objective;

      // errorBudgetTotal = (1 - objective / 100) * totalEvents  → số sự kiện xấu được phép
      const unreliabilityBudgetRatio = Math.max(0, 1 - objective / 100);
      const errorBudgetTotal =
        Math.round(unreliabilityBudgetRatio * totalEvents * 100) / 100;
      const errorBudgetConsumed = badEvents;

      // errorBudgetRemainingPercent = (1 - consumed / total) * 100, kẹp trong [0, 100]
      let errorBudgetRemainingPercent = 100;
      if (errorBudgetTotal > 0) {
        const rawRemaining =
          (1 - errorBudgetConsumed / errorBudgetTotal) * 100;
        errorBudgetRemainingPercent = Math.max(
          0,
          Math.min(100, Math.round(rawRemaining * 100) / 100),
        );
      } else {
        errorBudgetRemainingPercent = badEvents > 0 ? 0 : 100;
      }

      // burnRate = (badEvents / totalEvents) / (1 - objective / 100)
      // burnRate > 1 nghĩa là đang tiêu tốn ngân sách lỗi nhanh hơn mức cho phép
      let burnRate = 0;
      if (unreliabilityBudgetRatio > 0) {
        const actualErrorRate = badEvents / totalEvents;
        burnRate =
          Math.round((actualErrorRate / unreliabilityBudgetRatio) * 100) / 100;
      } else {
        burnRate = badEvents > 0 ? 999 : 0;
      }

      evaluations.push({
        id: target.id,
        key: target.key,
        name: target.name,
        sliType: target.sliType,
        objective,
        windowDays,
        latencyThresholdMs: target.latencyThresholdMs,
        routePrefix: target.routePrefix,
        totalEvents,
        goodEvents,
        badEvents,
        currentSliPercent,
        isMeetingObjective,
        errorBudgetTotal,
        errorBudgetConsumed,
        errorBudgetRemainingPercent,
        burnRate,
      });
    }

    return evaluations;
  }

  /**
   * 5. CRUD SloTarget: Danh sách tất cả mục tiêu SLO
   */
  async getSloTargets() {
    const repo = this.ensureSloTargetRepo();
    const list = await repo.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return list.map((item: any) => ({
      ...item,
      // XỬ LÝ DECIMAL: Ép Decimal sang Number
      objective: Number(item.objective),
    }));
  }

  /**
   * 5. CRUD SloTarget: Tạo mới mục tiêu SLO
   */
  async createSloTarget(dto: CreateSloTargetParams) {
    const repo = this.ensureSloTargetRepo();

    if (
      dto.sliType === 'LATENCY' &&
      (dto.latencyThresholdMs === undefined || dto.latencyThresholdMs === null)
    ) {
      throw new BadRequestException(
        'latencyThresholdMs là bắt buộc khi sliType là LATENCY',
      );
    }

    if (dto.objective <= 0 || dto.objective > 100) {
      throw new BadRequestException('objective phải nằm trong khoảng (0, 100]');
    }

    const existing = await repo.findUnique({
      where: { key: dto.key },
    });
    if (existing) {
      throw new BadRequestException(
        `SLO target với key '${dto.key}' đã tồn tại`,
      );
    }

    const created = await repo.create({
      data: {
        key: dto.key.trim(),
        name: dto.name.trim(),
        sliType: dto.sliType,
        objective: dto.objective,
        windowDays: dto.windowDays ?? 30,
        latencyThresholdMs:
          dto.sliType === 'LATENCY' ? dto.latencyThresholdMs : null,
        routePrefix: dto.routePrefix ? dto.routePrefix.trim() : null,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });

    return {
      ...created,
      objective: Number(created.objective),
    };
  }

  /**
   * 5. CRUD SloTarget: Cập nhật mục tiêu SLO
   */
  async updateSloTarget(id: string, dto: UpdateSloTargetParams) {
    const repo = this.ensureSloTargetRepo();

    const target = await repo.findUnique({
      where: { id },
    });
    if (!target) {
      throw new NotFoundException(`Không tìm thấy SLO target với id '${id}'`);
    }

    if (dto.key && dto.key !== target.key) {
      const existing = await repo.findUnique({
        where: { key: dto.key },
      });
      if (existing) {
        throw new BadRequestException(
          `SLO target với key '${dto.key}' đã tồn tại`,
        );
      }
    }

    const effectiveSliType = dto.sliType ?? target.sliType;
    if (effectiveSliType === 'LATENCY') {
      const effectiveThreshold =
        dto.latencyThresholdMs !== undefined
          ? dto.latencyThresholdMs
          : target.latencyThresholdMs;
      if (!effectiveThreshold) {
        throw new BadRequestException(
          'latencyThresholdMs là bắt buộc khi sliType là LATENCY',
        );
      }
    }

    if (
      dto.objective !== undefined &&
      (dto.objective <= 0 || dto.objective > 100)
    ) {
      throw new BadRequestException('objective phải nằm trong khoảng (0, 100]');
    }

    const updated = await repo.update({
      where: { id },
      data: {
        ...(dto.key !== undefined && { key: dto.key.trim() }),
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.sliType !== undefined && { sliType: dto.sliType }),
        ...(dto.objective !== undefined && { objective: dto.objective }),
        ...(dto.windowDays !== undefined && { windowDays: dto.windowDays }),
        ...(dto.latencyThresholdMs !== undefined && {
          latencyThresholdMs:
            effectiveSliType === 'LATENCY' ? dto.latencyThresholdMs : null,
        }),
        ...(dto.routePrefix !== undefined && {
          routePrefix: dto.routePrefix ? dto.routePrefix.trim() : null,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    return {
      ...updated,
      objective: Number(updated.objective),
    };
  }

  /**
   * 5. CRUD SloTarget: Xoá mục tiêu SLO
   */
  async deleteSloTarget(id: string) {
    const repo = this.ensureSloTargetRepo();

    const target = await repo.findUnique({
      where: { id },
    });
    if (!target) {
      throw new NotFoundException(`Không tìm thấy SLO target với id '${id}'`);
    }

    await repo.delete({
      where: { id },
    });

    return {
      message: 'Đã xoá mục tiêu SLO thành công',
      id,
    };
  }
}
