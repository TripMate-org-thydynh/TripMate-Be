const sendEachForMulticast = jest.fn();
jest.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp: jest.fn(() => ({})),
  cert: jest.fn((x) => x),
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ sendEachForMulticast }),
}));

import { PushService } from './push.service';

describe('PushService', () => {
  let prisma: any;
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    prisma = {
      deviceToken: {
        findMany: jest.fn().mockResolvedValue([
          { token: 'tok-alive' },
          { token: 'tok-dead' },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
  });

  afterAll(() => {
    process.env = env;
  });

  it('chưa có khoá thì ngủ: không gửi, không ném lỗi, nói thật là tắt', async () => {
    const svc = new PushService(prisma);
    expect(svc.enabled).toBe(false);
    const r = await svc.sendToUsers(['u1'], { title: 't', body: 'b' });
    expect(r).toEqual({ enabled: false, attempted: 0, delivered: 0 });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    // Không cả truy vấn token: tắt thì không tốn gì.
    expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
  });

  it('khoá hỏng thì tắt chứ không làm sập server', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{không phải json';
    const svc = new PushService(prisma);
    expect(svc.enabled).toBe(false);
  });

  it('có khoá thì gửi, đếm đúng số máy nhận, gỡ token đã chết', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
    sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
      ],
    });
    const svc = new PushService(prisma);
    const r = await svc.sendToUsers(['u1'], {
      title: 't',
      body: 'b',
      data: { day: 2, kind: 'MORNING_BRIEF' },
    });

    expect(r).toEqual({ enabled: true, attempted: 2, delivered: 1 });
    // FCM chỉ nhận chuỗi.
    expect(sendEachForMulticast.mock.calls[0][0].data).toEqual({
      day: '2',
      kind: 'MORNING_BRIEF',
    });
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['tok-dead'] } },
    });
  });

  it('lỗi tạm thời (không phải token chết) thì giữ token lại', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
    sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [
        { success: false, error: { code: 'messaging/internal-error' } },
        { success: false, error: { code: 'messaging/server-unavailable' } },
      ],
    });
    const svc = new PushService(prisma);
    await svc.sendToUsers(['u1'], { title: 't', body: 'b' });
    expect(prisma.deviceToken.deleteMany).not.toHaveBeenCalled();
  });

  it('token đổi chủ khi người khác đăng nhập trên cùng máy', async () => {
    const svc = new PushService(prisma);
    await svc.registerToken('u2', 'tok-alive');
    expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
      where: { token: 'tok-alive' },
      create: { userId: 'u2', token: 'tok-alive', platform: 'android' },
      update: { userId: 'u2', platform: 'android' },
    });
  });

  it('không gỡ được token máy của người khác', async () => {
    const svc = new PushService(prisma);
    await svc.removeToken('u1', 'tok-alive');
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', token: 'tok-alive' },
    });
  });
});
