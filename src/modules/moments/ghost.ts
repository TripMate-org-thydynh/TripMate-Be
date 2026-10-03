import { Prisma } from '@prisma/client';

/**
 * Ghost Cam — "máy ảnh phim": ảnh chụp ở chế độ ghost được tráng xong khi
 * chuyến đi kết thúc. Trước lúc đó chỉ người chụp thấy ảnh của mình; các
 * thành viên khác chỉ biết có bao nhiêu tấm đang chờ.
 *
 * Phải chặn ở server: nếu chỉ ẩn trên app thì ai đọc API cũng xem trước được,
 * và cả trò chơi mất ý nghĩa.
 *
 * `Trip.endDate` là cột DATE (nửa đêm UTC của ngày cuối). Chuyến coi như kết
 * thúc lúc hết ngày đó theo giờ Việt Nam = endDate + 24h − 7h = endDate + 17h.
 */
const REVEAL_OFFSET_MS = 17 * 3600 * 1000;

/** Mốc tráng ảnh của một chuyến có `endDate`. */
export function ghostRevealAt(endDate: Date): Date {
  return new Date(endDate.getTime() + REVEAL_OFFSET_MS);
}

/** Điều kiện Prisma: những khoảnh khắc `viewerId` được phép thấy. */
export function visibleMomentWhere(
  viewerId: string,
  now = new Date(),
): Prisma.MomentWhereInput {
  return {
    OR: [
      { isGhost: false },
      { userId: viewerId },
      {
        trip: {
          endDate: { lte: new Date(now.getTime() - REVEAL_OFFSET_MS) },
        },
      },
    ],
  };
}

/** Như trên nhưng không có người xem cụ thể: chỉ ảnh thường + ghost đã tráng. */
export function revealedMomentWhere(now = new Date()): Prisma.MomentWhereInput {
  return {
    OR: [
      { isGhost: false },
      {
        trip: {
          endDate: { lte: new Date(now.getTime() - REVEAL_OFFSET_MS) },
        },
      },
    ],
  };
}

/** Ảnh ghost còn đang "tráng" (chưa tới mốc). */
export function isDeveloping(
  m: { isGhost: boolean },
  tripEndDate: Date,
  now = new Date(),
): boolean {
  return m.isGhost && ghostRevealAt(tripEndDate).getTime() > now.getTime();
}
