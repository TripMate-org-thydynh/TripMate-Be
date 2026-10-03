import { ghostRevealAt, isDeveloping } from './ghost';

describe('Ghost Cam — mốc tráng ảnh', () => {
  // endDate là cột DATE: Prisma trả nửa đêm UTC của ngày cuối chuyến.
  const end = new Date('2027-01-13T00:00:00.000Z');

  it('tráng lúc hết ngày cuối theo giờ Việt Nam (00:00 ngày 14, UTC+7)', () => {
    expect(ghostRevealAt(end).toISOString()).toBe('2027-01-13T17:00:00.000Z');
  });

  it('23:59 ngày cuối (giờ VN) vẫn đang tráng', () => {
    const now = new Date('2027-01-13T16:59:00.000Z');
    expect(isDeveloping({ isGhost: true }, end, now)).toBe(true);
  });

  it('00:00 ngày hôm sau (giờ VN) đã tráng', () => {
    const now = new Date('2027-01-13T17:00:00.000Z');
    expect(isDeveloping({ isGhost: true }, end, now)).toBe(false);
  });

  it('ảnh thường không bao giờ "đang tráng"', () => {
    expect(isDeveloping({ isGhost: false }, end, new Date('2027-01-01'))).toBe(false);
  });
});
