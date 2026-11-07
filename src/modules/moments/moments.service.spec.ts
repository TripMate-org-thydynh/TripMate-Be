import { ForbiddenException } from '@nestjs/common';
import { MomentsService } from './moments.service';

describe('MomentsService — Shared Memory Photo Board (FEAT-BOARD)', () => {
  let service: MomentsService;
  let prisma: any;
  let activities: any;
  let entitlements: any;

  beforeEach(() => {
    prisma = {
      userBlock: { findMany: jest.fn().mockResolvedValue([]) },
      moment: {
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn(({ data }) =>
          Promise.resolve({
            id: 'moment-1',
            ...data,
            user: { id: data.userId, name: 'Linh', avatarUrl: null },
            _count: { reactions: 0, comments: 0 },
          }),
        ),
        findFirst: jest.fn(),
        update: jest.fn(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            ...data,
            user: { id: 'user-1', name: 'Linh', avatarUrl: null },
            reactions: [],
            _count: { reactions: 0, comments: 0 },
          }),
        ),
      },
      tripMember: {
        findFirst: jest.fn(),
      },
    };
    activities = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    entitlements = {
      assertTripWithin: jest.fn().mockResolvedValue(undefined),
    };
    service = new MomentsService(prisma, activities, entitlements);
  });

  it('assigns deterministic default board coordinates & rotation when creating a moment', async () => {
    const res = await service.create('trip-1', 'user-1', {
      mediaUrl: 'https://storage.supabase.co/photo1.jpg',
      caption: 'Hoàng hôn Đà Lạt',
    });

    expect(typeof res.boardX).toBe('number');
    expect(typeof res.boardY).toBe('number');
    expect(typeof res.boardRotation).toBe('number');
    expect(res.boardScale).toBe(1.0);
    expect(res.boardFilter).toBe('CLASSIC');
    expect(res.isPinned).toBe(false);
    expect(res.isFavorite).toBe(false);
  });

  it('updates Polaroid board layout and restricts caption changes to author or trip creator', async () => {
    prisma.moment.count.mockResolvedValue(1);
    prisma.moment.findFirst.mockResolvedValue({
      id: 'moment-1',
      tripId: 'trip-1',
      userId: 'user-1',
      deletedAt: null,
    });

    // Another member can move/rotate/pin/filter the Polaroid on the shared board
    const moved = await service.updateLayout('trip-1', 'moment-1', 'user-2', {
      boardX: 180,
      boardY: 260,
      boardRotation: -4.5,
      boardFilter: 'WARM_VINTAGE',
      isPinned: true,
    });

    expect(moved.boardX).toBe(180);
    expect(moved.boardY).toBe(260);
    expect(moved.boardRotation).toBe(-4.5);
    expect(moved.boardFilter).toBe('WARM_VINTAGE');
    expect(moved.isPinned).toBe(true);

    // Non-author non-creator cannot overwrite caption via updateLayout
    prisma.tripMember.findFirst.mockResolvedValue(null);
    await expect(
      service.updateLayout('trip-1', 'moment-1', 'user-2', {
        caption: 'Sửa hộ caption',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('toggles isFavorite on a moment', async () => {
    prisma.moment.count.mockResolvedValue(1);
    prisma.moment.findFirst.mockResolvedValue({
      id: 'moment-1',
      tripId: 'trip-1',
      userId: 'user-1',
      isFavorite: false,
      deletedAt: null,
    });

    const res = await service.toggleFavorite('trip-1', 'moment-1', 'user-2');
    expect(res.isFavorite).toBe(true);
  });

  it('serves subsequent group members from shared L1/Redis board cache and invalidates on layout mutation', async () => {
    const cacheMock = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    prisma.trip = {
      findUnique: jest.fn().mockResolvedValue({ endDate: null }),
    };
    prisma.moment.findMany = jest.fn().mockResolvedValue([
      {
        id: 'moment-1',
        tripId: 'trip-1',
        userId: 'user-1',
        mediaUrl: 'https://res.cloudinary.com/demo/image/upload/v1/sample.jpg',
        isGhost: false,
        boardX: 120,
        boardY: 180,
      },
    ]);

    const cachedService = new MomentsService(
      prisma,
      activities,
      entitlements,
      cacheMock as any,
    );

    // First member opens the board -> populates shared cache
    const firstView = await cachedService.findAll('trip-1', 'user-1');
    expect(firstView).toHaveLength(1);
    expect(prisma.moment.findMany).toHaveBeenCalledTimes(1);
    expect(cacheMock.set).toHaveBeenCalledTimes(1);

    // Second member opens the board -> served from shared cache without hitting DB
    const secondView = await cachedService.findAll('trip-1', 'user-2');
    expect(secondView).toHaveLength(1);
    expect(prisma.moment.findMany).toHaveBeenCalledTimes(1);

    // Layout update invalidates shared cache so next fetch reflects new coordinates
    prisma.moment.count.mockResolvedValue(1);
    prisma.moment.findFirst.mockResolvedValue({
      id: 'moment-1',
      tripId: 'trip-1',
      userId: 'user-1',
      deletedAt: null,
    });
    await cachedService.updateLayout('trip-1', 'moment-1', 'user-2', {
      boardX: 340,
      boardY: 420,
    });
    expect(cacheMock.del).toHaveBeenCalledWith('board:trip:trip-1:v1');
  });
});
