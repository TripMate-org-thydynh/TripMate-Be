import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

export interface MetricAgg {
  bucketStart: Date;
  route: string;
  method: string;
  statusClass: number;
  count: number;
  sumLatencyMs: bigint;
  maxLatencyMs: number;
  le50: number;
  le100: number;
  le250: number;
  le500: number;
  le1000: number;
  le2500: number;
  le5000: number;
  leInf: number;
}

export interface RecordMetricParams {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

/**
 * Service lưu trữ bộ đệm số liệu hiệu năng (Request Metrics Buffer) trong bộ nhớ.
 *
 * Nguyên tắc:
 * 1. Không ghi DB mỗi request để tránh quá tải I/O.
 * 2. Gộp theo bucket 1 phút (UTC, cắt giây và ms) và route pattern.
 * 3. Ghi nhận histogram phân loại độ trễ (latency buckets) kiểu Prometheus.
 * 4. Định kỳ flush vào DB bằng @Cron mỗi 30 giây.
 * 5. Tự động dọn dẹp dữ liệu cũ hơn 90 ngày mỗi ngày lúc 3h sáng.
 */
@Injectable()
export class MetricsBufferService {
  private readonly logger = new Logger(MetricsBufferService.name);

  /** Bộ đệm in-memory, khoá gộp: `${bucketStartISO}|${route}|${method}|${statusClass}` */
  private buffer = new Map<string, MetricAgg>();

  /** Giới hạn số lượng entry tối đa trong Map để chống tràn bộ nhớ khi DB gặp sự cố kéo dài */
  private readonly MAX_BUFFER_SIZE = 10000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ghi nhận 1 request vào bộ đệm trong bộ nhớ.
   *
   * HÀM NÀY PHẢI CỰC NHẸ VÀ ĐỒNG BỘ (sync, không async, không gọi DB hay I/O).
   */
  record({ route, method, statusCode, durationMs }: RecordMetricParams): void {
    try {
      // 1. Tính bucket đầu phút (UTC) bằng phép toán chia nguyên mili-giây
      const bucketStartMs = Math.floor(Date.now() / 60000) * 60000;
      const bucketStart = new Date(bucketStartMs);
      const bucketStartISO = bucketStart.toISOString();

      // 2. statusClass: 2 = 2xx, 3 = 3xx, 4 = 4xx, 5 = 5xx
      const validStatusCode =
        Number.isInteger(statusCode) && statusCode >= 100 && statusCode < 600
          ? statusCode
          : 500;
      const statusClass = Math.floor(validStatusCode / 100);
      const normalizedMethod = (method || 'GET').toUpperCase();

      // 3. Khoá gộp
      const key = `${bucketStartISO}|${route}|${normalizedMethod}|${statusClass}`;

      let agg = this.buffer.get(key);
      if (!agg) {
        // Kiểm tra giới hạn bộ nhớ trước khi tạo entry mới
        if (this.buffer.size >= this.MAX_BUFFER_SIZE) {
          this.logger.warn(
            `Bộ đệm metrics đạt ngưỡng tối đa (${this.MAX_BUFFER_SIZE} mục). Tạm thời không nhận thêm entry mới.`,
          );
          return;
        }

        agg = {
          bucketStart,
          route,
          method: normalizedMethod,
          statusClass,
          count: 0,
          sumLatencyMs: 0n,
          maxLatencyMs: 0,
          le50: 0,
          le100: 0,
          le250: 0,
          le500: 0,
          le1000: 0,
          le2500: 0,
          le5000: 0,
          leInf: 0,
        };
        this.buffer.set(key, agg);
      }

      // 4. Cộng dồn số liệu
      const roundedDuration = Math.max(0, Math.round(durationMs));
      agg.count += 1;
      agg.sumLatencyMs += BigInt(roundedDuration);
      if (roundedDuration > agg.maxLatencyMs) {
        agg.maxLatencyMs = roundedDuration;
      }

      // 5. Tăng ĐÚNG MỘT bucket histogram theo durationMs
      if (durationMs <= 50) {
        agg.le50 += 1;
      } else if (durationMs <= 100) {
        agg.le100 += 1;
      } else if (durationMs <= 250) {
        agg.le250 += 1;
      } else if (durationMs <= 500) {
        agg.le500 += 1;
      } else if (durationMs <= 1000) {
        agg.le1000 += 1;
      } else if (durationMs <= 2500) {
        agg.le2500 += 1;
      } else if (durationMs <= 5000) {
        agg.le5000 += 1;
      } else {
        agg.leInf += 1;
      }
    } catch (err) {
      // Đo lường không bao giờ được làm sập hay ảnh hưởng logic chính
      this.logger.warn(
        `Không thể ghi nhận metric vào bộ đệm: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Định kỳ 30 giây xả bộ đệm in-memory xuống bảng `request_metrics`.
   * Reset Map ngay lập tức để tránh tranh chấp khi có request mới đến.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'metrics-flush' })
  async flush(): Promise<void> {
    if (this.buffer.size === 0) {
      return;
    }

    // Lấy toàn bộ Map ra rồi RESET Map ngay lập tức
    const currentBuffer = this.buffer;
    this.buffer = new Map<string, MetricAgg>();

    // Map theo dõi các mục chưa được ghi thành công vào DB
    const unwritten = new Map<string, MetricAgg>(currentBuffer);

    try {
      const requestMetricDelegate = (this.prisma as any).requestMetric;
      if (
        !requestMetricDelegate ||
        typeof requestMetricDelegate.upsert !== 'function'
      ) {
        this.logger.warn(
          'PrismaClient chưa sinh delegate `requestMetric` (cần chạy `npx prisma generate`). Giữ lại bộ đệm cho chu kỳ sau.',
        );
        this.mergeBack(currentBuffer);
        return;
      }

      for (const [key, item] of currentBuffer.entries()) {
        await requestMetricDelegate.upsert({
          where: {
            bucketStart_route_method_statusClass: {
              bucketStart: item.bucketStart,
              route: item.route,
              method: item.method,
              statusClass: item.statusClass,
            },
          },
          create: {
            bucketStart: item.bucketStart,
            route: item.route,
            method: item.method,
            statusClass: item.statusClass,
            count: item.count,
            sumLatencyMs: item.sumLatencyMs,
            maxLatencyMs: item.maxLatencyMs,
            le50: item.le50,
            le100: item.le100,
            le250: item.le250,
            le500: item.le500,
            le1000: item.le1000,
            le2500: item.le2500,
            le5000: item.le5000,
            leInf: item.leInf,
          },
          update: {
            count: { increment: item.count },
            sumLatencyMs: { increment: item.sumLatencyMs },
            le50: { increment: item.le50 },
            le100: { increment: item.le100 },
            le250: { increment: item.le250 },
            le500: { increment: item.le500 },
            le1000: { increment: item.le1000 },
            le2500: { increment: item.le2500 },
            le5000: { increment: item.le5000 },
            leInf: { increment: item.leInf },
          },
        });

        // Xoá mục đã ghi xong khỏi danh sách chờ thử lại
        unwritten.delete(key);
      }
    } catch (error) {
      this.logger.warn(
        `Lỗi khi flush metrics vào database: ${error instanceof Error ? error.message : String(error)}. Hoàn lại ${unwritten.size} mục chưa ghi vào bộ đệm.`,
      );
      if (unwritten.size > 0) {
        this.mergeBack(unwritten);
      }
    }
  }

  /**
   * Hoàn trả các bản ghi chưa flush thành công về lại Map bộ đệm.
   * Cộng dồn với dữ liệu mới đang tích luỹ nếu trùng khoá.
   */
  private mergeBack(failedItems: Map<string, MetricAgg>): void {
    for (const [key, item] of failedItems.entries()) {
      if (this.buffer.size >= this.MAX_BUFFER_SIZE && !this.buffer.has(key)) {
        this.logger.warn(
          `Bộ đệm metric đã vượt trần an toàn (${this.MAX_BUFFER_SIZE}), huỷ bớt số liệu để bảo vệ bộ nhớ.`,
        );
        break;
      }

      const existing = this.buffer.get(key);
      if (existing) {
        existing.count += item.count;
        existing.sumLatencyMs += item.sumLatencyMs;
        existing.maxLatencyMs = Math.max(
          existing.maxLatencyMs,
          item.maxLatencyMs,
        );
        existing.le50 += item.le50;
        existing.le100 += item.le100;
        existing.le250 += item.le250;
        existing.le500 += item.le500;
        existing.le1000 += item.le1000;
        existing.le2500 += item.le2500;
        existing.le5000 += item.le5000;
        existing.leInf += item.leInf;
      } else {
        this.buffer.set(key, item);
      }
    }
  }

  /**
   * Dọn dẹp dữ liệu metrics cũ quá 90 ngày.
   *
   * Với độ phân giải bucket 1 phút, mỗi route x method x statusClass tạo ra 1 dòng mỗi phút.
   * Nếu hệ thống có 100 endpoint và hoạt động liên tục, 1 ngày có thể sinh ~144.000 dòng.
   * Dữ liệu metric sẽ phình rất nhanh theo thời gian, do đó cần chính sách retention
   * định kỳ xoá các bản ghi cũ hơn 90 ngày (đủ cho cửa sổ SLO 30 ngày / quý) để bảo vệ dung lượng DB.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'metrics-retention' })
  async cleanOldMetrics(): Promise<void> {
    try {
      const requestMetricDelegate = (this.prisma as any).requestMetric;
      if (
        !requestMetricDelegate ||
        typeof requestMetricDelegate.deleteMany !== 'function'
      ) {
        return;
      }

      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const deleteResult = await requestMetricDelegate.deleteMany({
        where: {
          bucketStart: {
            lt: ninetyDaysAgo,
          },
        },
      });

      if (deleteResult && deleteResult.count > 0) {
        this.logger.log(
          `[metrics-retention] Đã xoá ${deleteResult.count} bản ghi metric cũ hơn 90 ngày (< ${ninetyDaysAgo.toISOString()}).`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[metrics-retention] Lỗi khi dọn dẹp metrics cũ: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Phương thức hỗ trợ kiểm tra kích thước bộ đệm (dùng cho debug/chẩn đoán).
   */
  getBufferSize(): number {
    return this.buffer.size;
  }
}
