import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ItineraryTemplatesService } from './itinerary-templates.service';

/**
 * Luật nghiệp vụ của lịch trình mẫu — kiểm bằng Prisma giả, không đụng DB.
 */
describe('ItineraryTemplatesService', () => {
  const item = (
    day: number,
    notes: string | null = 'Phòng 204, SĐT chủ nhà',
  ) => ({
    id: `i${day}`,
    day,
    startTime: '08:00',
    placeName: `Điểm ${day}`,
    placeAddress: 'Đà Lạt',
    latitude: null,
    longitude: null,
    durationMinutes: 60,
    notes,
    category: 'OTHER',
  });

  const template = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    authorId: 'author',
    title: 'Đà Lạt 3 ngày',
    description: null,
    destination: 'Đà Lạt',
    coverImage: null,
    vibe: null,
    dayCount: 3,
    stopCount: 2,
    isPublic: true,
    deletedAt: null,
    items: [item(1), item(3)],
    ...over,
  });

  let prisma: any;
  let trips: any;
  let cache: any;
  let ai: any;
  let itins: any;
  let svc: ItineraryTemplatesService;

  beforeEach(() => {
    prisma = {
      trip: { findUnique: jest.fn(), delete: jest.fn().mockResolvedValue({}) },
      tripMember: { findUnique: jest.fn() },
      itineraryItem: { createMany: jest.fn().mockReturnValue('createMany') },
      itineraryTemplate: {
        create: jest.fn((a) => a),
        findUnique: jest.fn(),
        update: jest.fn().mockReturnValue('increment'),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    trips = { create: jest.fn().mockResolvedValue({ id: 'newTrip' }) };
    cache = { del: jest.fn() };
    ai = { customizeItinerary: jest.fn() };
    itins = { geocodeMissing: jest.fn().mockResolvedValue({}) };
    svc = new ItineraryTemplatesService(prisma, trips, cache, ai, itins);
  });

  describe('publish', () => {
    const trip = (itineraries: unknown[]) => ({
      id: 'trip1',
      name: 'Chuyến gốc',
      description: null,
      destination: 'Đà Lạt',
      coverImage: null,
      vibe: 'CHILL',
      itineraries,
    });

    it('chụp đủ điểm dừng, dayCount là ngày lớn nhất', async () => {
      prisma.trip.findUnique.mockResolvedValue(trip([item(1), item(4)]));
      const res: any = await svc.publish('trip1', 'u1', {});
      expect(res.data.dayCount).toBe(4);
      expect(res.data.stopCount).toBe(2);
      expect(res.data.title).toBe('Chuyến gốc');
      expect(res.data.authorId).toBe('u1');
    });

    it('mặc định KHÔNG chép ghi chú riêng của nhóm', async () => {
      prisma.trip.findUnique.mockResolvedValue(trip([item(1)]));
      const res: any = await svc.publish('trip1', 'u1', {});
      expect(res.data.items.create[0].notes).toBeNull();
    });

    it('chép ghi chú khi người đăng chủ động bật includeNotes', async () => {
      prisma.trip.findUnique.mockResolvedValue(trip([item(1)]));
      const res: any = await svc.publish('trip1', 'u1', { includeNotes: true });
      expect(res.data.items.create[0].notes).toBe('Phòng 204, SĐT chủ nhà');
    });

    it('từ chối chuyến chưa có điểm dừng', async () => {
      prisma.trip.findUnique.mockResolvedValue(trip([]));
      await expect(svc.publish('trip1', 'u1', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('findOne', () => {
    it('mẫu riêng tư của người khác → 404 (không lộ là tồn tại)', async () => {
      prisma.itineraryTemplate.findUnique.mockResolvedValue(
        template({ isPublic: false }),
      );
      await expect(svc.findOne('t1', 'stranger')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('tác giả vẫn xem được mẫu riêng tư của mình', async () => {
      prisma.itineraryTemplate.findUnique.mockResolvedValue(
        template({ isPublic: false }),
      );
      await expect(svc.findOne('t1', 'author')).resolves.toBeTruthy();
    });
  });

  describe('duplicate', () => {
    beforeEach(() =>
      prisma.itineraryTemplate.findUnique.mockResolvedValue(template()),
    );

    it('tạo chuyến mới qua TripsService.create (chịu hạn mức), đủ số ngày', async () => {
      const res = await svc.duplicate('t1', 'u2', { startDate: '2026-10-01' });
      expect(trips.create).toHaveBeenCalledWith(
        'u2',
        expect.objectContaining({
          name: 'Đà Lạt 3 ngày',
          startDate: '2026-10-01',
          endDate: '2026-10-03',
        }),
      );
      expect(res).toEqual({
        tripId: 'newTrip',
        createdTrip: true,
        copiedStops: 2,
      });
    });

    it('hạn mức từ chối thì không chép gì', async () => {
      trips.create.mockRejectedValue(new ForbiddenException('quota'));
      await expect(svc.duplicate('t1', 'u2', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('người khác nhân bản → tăng lượt dùng', async () => {
      await svc.duplicate('t1', 'u2', {});
      expect(prisma.$transaction.mock.calls[0][0]).toEqual([
        'createMany',
        'increment',
      ]);
    });

    it('tác giả tự nhân bản → KHÔNG tăng lượt dùng', async () => {
      await svc.duplicate('t1', 'author', {});
      expect(prisma.$transaction.mock.calls[0][0]).toEqual(['createMany']);
    });

    it('chép vào chuyến mà mình không phải thành viên → 403', async () => {
      prisma.tripMember.findUnique.mockResolvedValue(null);
      await expect(
        svc.duplicate('t1', 'u2', { tripId: 'someone-else-trip' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(trips.create).not.toHaveBeenCalled();
    });

    it('chép vào chuyến đang có: không tạo chuyến mới', async () => {
      prisma.tripMember.findUnique.mockResolvedValue({
        trip: { deletedAt: null },
      });
      const res = await svc.duplicate('t1', 'u2', { tripId: 'mine' });
      expect(trips.create).not.toHaveBeenCalled();
      expect(res.tripId).toBe('mine');
      expect(cache.del).toHaveBeenCalledWith('trip:mine:itinerary');
    });

    it('chép điểm dừng lỗi → xoá chuyến rỗng vừa tạo', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      await expect(svc.duplicate('t1', 'u2', {})).rejects.toThrow('db down');
      expect(prisma.trip.delete).toHaveBeenCalledWith({
        where: { id: 'newTrip' },
      });
    });
  });
});
