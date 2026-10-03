import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';

/**
 * Tính giới hạn tần suất theo NGƯỜI DÙNG thay vì theo IP, cho các route đã
 * đăng nhập.
 *
 * Theo IP thì cả nhóm bạn ngồi chung một Wi-Fi (một IP NAT) dùng chung một xô:
 * mười hai người cùng bấm link mời trong một phút là có người ăn 429 — đúng
 * tình huống sử dụng chính của app.
 *
 * ThrottlerGuard là guard toàn cục, chạy TRƯỚC JwtAuthGuard nên chưa có
 * `req.user`; ở đây chỉ đọc `sub` trong JWT mà không kiểm chữ ký. Vậy là đủ:
 * token giả mang `sub` bịa sẽ bị JwtAuthGuard trả 401 ngay sau đó, không chạm
 * được vào thứ đang được bảo vệ. Không có token thì quay về theo IP.
 */
export const userOrIpTracker: ThrottlerGetTrackerFunction = (req) => {
  const auth: unknown = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(
        Buffer.from(auth.slice(7).split('.')[1] ?? '', 'base64url').toString(),
      ) as { sub?: unknown };
      if (typeof payload.sub === 'string' && payload.sub) {
        return `user:${payload.sub}`;
      }
    } catch {
      // token hỏng → theo IP
    }
  }
  return String(req.ip);
};
