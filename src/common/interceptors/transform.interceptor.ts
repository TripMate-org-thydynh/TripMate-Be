import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs/operators';

/// Đánh dấu endpoint phải trả **nguyên văn**, không bọc envelope.
///
/// Webhook của cổng thanh toán quy định sẵn hình dạng phản hồi (ZaloPay đọc
/// `return_code` ở gốc). Bọc chúng trong `{success, data}` thì cổng không đọc
/// được và sẽ coi như giao dịch thất bại, rồi gọi lại webhook mãi.
export const RAW_RESPONSE = 'raw_response';
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

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
  if (seen.has(value)) return value;
  seen.add(value);

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
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) {
      return next.handle().pipe(map((data) => normalizeDecimals(data)));
    }
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data: normalizeDecimals(data) as T,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
