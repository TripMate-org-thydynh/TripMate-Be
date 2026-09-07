import { Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { MetricsBufferService } from './metrics-buffer.service';
import { extractRoutePattern, isExcludedPath } from './route-label';

/**
 * Factory tạo Express middleware ghi nhận thời gian phản hồi (latency) và mã trạng thái HTTP.
 *
 * Gắn trực tiếp vào Express instance trong main.ts, chạy trước Guard, Interceptor và Router,
 * cho phép ghi nhận toàn bộ response kể cả 401/403/429 ném từ Guard và 404 từ router.
 *
 * Nguyên tắc:
 * 1. Thu thập route pattern (ví dụ `/trips/:tripId/expenses`) thay vì URL thật.
 * 2. Không phân giải được pattern (404) thì gom vào nhãn `'unknown'`, tuyệt đối không dùng URL thật.
 * 3. Bỏ qua không đo endpoint `/health` và các endpoint `/admin/observability`.
 * 4. Đo lường độc lập, try/catch bọc kín, tuyệt đối không làm ảnh hưởng hay làm sập request của người dùng.
 * 5. Lắng nghe sự kiện `finish` trên response, KHÔNG dùng `close` để tránh nhiễu do client huỷ kết nối giữa chừng.
 */
export function makeMetricsMiddleware(buffer: MetricsBufferService) {
  const logger = new Logger('MetricsMiddleware');

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Bỏ qua sớm nếu URL là đường dẫn loại trừ (/health, /admin/observability...)
      const rawPath = req.originalUrl || req.url || req.path || '';
      if (isExcludedPath(rawPath)) {
        return next();
      }

      const startTime = performance.now();
      let recorded = false;

      res.on('finish', () => {
        if (recorded) return;
        recorded = true;

        try {
          const durationMs = performance.now() - startTime;
          const route = extractRoutePattern(req);

          // Kiểm tra lại sau khi đã giải mã route pattern
          if (isExcludedPath(route)) {
            return;
          }

          const method = req.method || 'GET';
          const statusCode = res.statusCode || 200;

          buffer.record({
            route,
            method,
            statusCode,
            durationMs,
          });
        } catch (err) {
          // Nuốt lỗi hoàn toàn, đo lường không được làm hỏng request
          logger.warn(
            `Lỗi khi ghi nhận metric: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    } catch (err) {
      logger.warn(
        `Lỗi trong metrics middleware: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    next();
  };
}
