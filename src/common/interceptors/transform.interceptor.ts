import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
}

/**
 * Đổi Prisma `Decimal` thành `number` trong toàn bộ response.
 *
 * Decimal của Prisma không phải kiểu JSON nguyên thuỷ: qua serialisation nó ra
 * `{"s":1,"e":7,"d":[1,5000000]}`. Client đọc `budget`/`amount` bằng
 * `as num?` sẽ ném TypeError và **hỏng nguyên list** — đúng như BUG-002 khiến
 * app báo "Chưa có chuyến nào" dù API trả về đủ chuyến.
 *
 * Trước đây lỗi này chỉ được vá riêng cho `expenses`, nên nó tái diễn ngay ở
 * `trips.budget`. Xử lý ở interceptor toàn cục để mọi endpoint hiện tại và
 * tương lai đều trả số thật.
 *
 * Giữ nguyên `Date` (JSON tự đổi sang ISO string) và `Buffer`.
 */
function normalizeDecimals(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Decimal (decimal.js) lộ ra qua `toNumber` + `s/e/d`.
  const maybeDecimal = value as { toNumber?: () => number };
  if (typeof maybeDecimal.toNumber === 'function') {
    return maybeDecimal.toNumber();
  }

  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  // Tránh lặp vô hạn nếu có tham chiếu vòng.
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => normalizeDecimals(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normalizeDecimals(v, seen);
  }
  return out;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data: normalizeDecimals(data) as T,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
