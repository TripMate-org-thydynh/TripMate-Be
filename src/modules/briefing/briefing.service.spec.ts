// @nestjs/schedule v12 là ESM, Jest (CommonJS) không đọc được — chỉ cần decorator rỗng.
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { BriefingService, todayVN } from './briefing.service';

describe('BriefingService', () => {
  let prisma: any;
  let weather: any;
  let push: any;
  let svc: BriefingService;

  beforeEach(() => {
    prisma = {
      trip: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 't1', members: [{ userId: 'a' }, { userId: 'b' }] },
          ]),
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          name: 'Đà Lạt',
          startDate: new Date('2026-09-21T00:00:00Z'),
          endDate: new Date('2026-09-24T00:00:00Z'),
        }),
      },
      itineraryItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'i1', startTime: '08:30', placeName: 'Chợ Đà Lạt' },
          ]),
      },
      todoItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd1',
            title: 'Mua vé',
            priority: 'HIGH',
            assignee: { name: 'Minh' },
          },
        ]),
      },
      notification: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    weather = {
      forTrip: jest.fn().mockResolvedValue({
        days: [
          {
            day: 2,
            available: true,
            weatherCode: 61,
            tempMin: 16,
            tempMax: 24,
            rainProbability: 80,
          },
        ],
        alerts: [{ itemId: 'i1', day: 2, rainProbability: 70 }],
      }),
    };
    push = {
      enabled: true,
      sendToUsers: jest
        .fn()
        .mockResolvedValue({ enabled: true, attempted: 2, delivered: 2 }),
    };
    svc = new BriefingService(prisma, weather, push);
  });

  it('tính đúng ngày thứ mấy + ghép thời tiết, điểm, việc, người phụ trách', async () => {
    const b = await svc.buildForTrip('t1', '2026-09-22');
    expect(b.day).toBe(2);
    expect(b.weather?.rainProbability).toBe(80);
    expect(b.stops[0].rainRisk).toBe(70);
    expect(b.todos[0].assigneeName).toBe('Minh');
    expect(b.summary).toContain('mưa 80%');
    expect(b.summary).toContain('08:30');
  });

  it('gửi cho mọi thành viên chuyến đang diễn ra', async () => {
    expect(await svc.sendAll('2026-09-22')).toBe(2);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  it('không gửi trùng khi cron chạy lại trong ngày', async () => {
    prisma.notification.findFirst.mockResolvedValue({ id: 'x' });
    expect(await svc.sendAll('2026-09-22')).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    // Cron chạy lại không được làm điện thoại rung thêm lần nữa.
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('đẩy lên máy đúng những người vừa có bản tin, gộp một lần mỗi chuyến', async () => {
    const r = await svc.sendAllDetailed('2026-09-22');
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [users, msg] = push.sendToUsers.mock.calls[0];
    expect(users).toHaveLength(2);
    expect(msg.data.kind).toBe('MORNING_BRIEF');
    expect(r).toEqual({ created: 2, pushEnabled: true, pushDelivered: 2 });
  });

  it('chưa cấu hình Firebase thì vẫn tạo thông báo trong app và nói thật là không đẩy', async () => {
    push.enabled = false;
    push.sendToUsers.mockResolvedValue({
      enabled: false,
      attempted: 0,
      delivered: 0,
    });
    const r = await svc.sendAllDetailed('2026-09-22');
    expect(r.created).toBe(2);
    expect(r.pushEnabled).toBe(false);
    expect(r.pushDelivered).toBe(0);
  });

  it('đẩy lỗi không làm mất thông báo trong app', async () => {
    push.sendToUsers.mockRejectedValue(new Error('fcm down'));
    expect(await svc.sendAll('2026-09-22')).toBe(2);
  });

  it('thời tiết lỗi vẫn gửi được bản tin', async () => {
    weather.forTrip.mockRejectedValue(new Error('open-meteo down'));
    const b = await svc.buildForTrip('t1', '2026-09-22');
    expect(b.weather).toBeNull();
    expect(b.stops).toHaveLength(1);
  });

  it('todayVN theo giờ Việt Nam (UTC+7)', () => {
    expect(todayVN(new Date('2026-09-20T17:30:00Z'))).toBe('2026-09-21');
  });
});
