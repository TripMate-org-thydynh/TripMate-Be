import {
  GooglePlayBillingService,
  PlayReceiptRejected,
  PlaySubscriptionV2,
} from './google-play-billing.service';

/**
 * Gói Play giữ nguyên token qua mọi kỳ. Câu hỏi test trả lời: sau mỗi sự kiện
 * của Google (gia hạn, tắt gia hạn, treo, hết hạn, hoàn tiền), quyền phía mình
 * có khớp đúng với thứ người dùng đã trả tiền không.
 */
describe('GooglePlayBillingService', () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const DAY = 86_400_000;
  let subs: any[];
  let orders: any[];
  let prisma: any;
  let trials: any;
  let service: GooglePlayBillingService;

  const sub = (over: Partial<PlaySubscriptionV2> = {}): PlaySubscriptionV2 => ({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.1111-2222-3333-44444',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [
      {
        productId: 'tripmate_plus_monthly',
        expiryTime: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    ],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: USER },
    ...over,
  });

  const match = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) =>
      v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v,
    );

  beforeEach(() => {
    subs = [];
    orders = [];
    prisma = {
      subscription: {
        findFirst: jest.fn(async ({ where }: any) => subs.find((r) => match(r, where)) ?? null),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `s${subs.length + 1}`, canceledAt: null, ...data };
          subs.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = subs.find((r) => r.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      paymentOrder: {
        findUnique: jest.fn(async ({ where }: any) => orders.find((o) => o.orderId === where.orderId) ?? null),
        create: jest.fn(async ({ data }: any) => (orders.push({ ...data }), data)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = orders.filter((o) => match(o, where));
          hit.forEach((o) => Object.assign(o, data));
          return { count: hit.length };
        }),
      },
      user: { findUnique: jest.fn(async ({ where }: any) => (where.id === USER ? { id: USER } : null)) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    trials = { log: jest.fn(), markConverted: jest.fn() };
    service = new GooglePlayBillingService(prisma, trials);
  });

  describe('apply — chép trạng thái Google về', () => {
    it('mua mới: tạo gói, hạn đúng bằng hạn Google, ghi một hoá đơn', async () => {
      const data = sub();
      const r = await service.apply(USER, 'tok', data, 'test');
      expect(r).toMatchObject({ created: true, newPeriod: true, status: 'ACTIVE', plan: 'PLUS' });
      expect(subs[0].currentPeriodEnd.toISOString()).toBe(data.lineItems![0].expiryTime);
      expect(orders).toHaveLength(1);
      expect(orders[0].orderId).toBe('play.GPA.1111-2222-3333-44444');
    });

    it('GIA HẠN (cùng token, orderId mới): hạn dời theo Google, thêm hoá đơn kỳ mới', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      const later = new Date(Date.now() + 60 * DAY).toISOString();
      const r = await service.apply(
        USER,
        'tok',
        sub({
          latestOrderId: 'GPA.1111-2222-3333-44444..0',
          lineItems: [{ productId: 'tripmate_plus_monthly', expiryTime: later }],
        }),
        'test',
      );
      expect(r).toMatchObject({ created: false, newPeriod: true });
      expect(subs).toHaveLength(1);
      expect(subs[0].currentPeriodEnd.toISOString()).toBe(later);
      expect(orders).toHaveLength(2);
      expect(trials.log).toHaveBeenLastCalledWith(USER, 'SUBSCRIPTION_RENEWED', expect.anything(), prisma);
    });

    it('đồng bộ lại cùng kỳ nhiều lần: không thêm hoá đơn, không đổi gì', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      const r = await service.apply(USER, 'tok', sub(), 'test');
      expect(r).toMatchObject({ created: false, newPeriod: false });
      expect(orders).toHaveLength(1);
    });

    it('tắt gia hạn: VẪN còn quyền tới hết kỳ đã trả', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      await service.apply(USER, 'tok', sub({ subscriptionState: 'SUBSCRIPTION_STATE_CANCELED' }), 'test');
      expect(subs[0]).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true });
      expect(subs[0].currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    });

    it('trừ tiền thất bại (ON_HOLD): mất quyền nhưng gói chưa chết', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      await service.apply(USER, 'tok', sub({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }), 'test');
      expect(subs[0].status).toBe('PAST_DUE');
    });

    it('hết hạn: hạn không được nằm ở tương lai', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      await service.apply(USER, 'tok', sub({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }), 'test');
      expect(subs[0].status).toBe('EXPIRED');
      expect(subs[0].currentPeriodEnd.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('nâng gói (token mới + linkedPurchaseToken): nối vào gói cũ, không đẻ gói thứ hai', async () => {
      await service.apply(USER, 'tok-old', sub(), 'test');
      await service.apply(
        USER,
        'tok-new',
        sub({
          linkedPurchaseToken: 'tok-old',
          latestOrderId: 'GPA.9999',
          lineItems: [
            { productId: 'tripmate_squad_monthly', expiryTime: new Date(Date.now() + 30 * DAY).toISOString() },
          ],
        }),
        'test',
      );
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ externalId: 'tok-new', plan: 'SQUAD', seats: 5 });
    });

    it('chờ thanh toán / sản phẩm lạ: không ghi gì', async () => {
      expect(await service.apply(USER, 't', sub({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }), 'x')).toBeNull();
      expect(
        await service.apply(USER, 't', sub({ lineItems: [{ productId: 'la', expiryTime: new Date().toISOString() }] }), 'x'),
      ).toBeNull();
      expect(subs).toHaveLength(0);
    });
  });

  describe('revoke — hoàn tiền', () => {
    it('cắt quyền NGAY và đánh dấu hoá đơn REFUNDED', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      expect(await service.revoke('tok', 'rtdn:voided', 'GPA.1111-2222-3333-44444')).toBe(true);
      expect(subs[0].status).toBe('CANCELED');
      expect(subs[0].currentPeriodEnd.getTime()).toBeLessThanOrEqual(Date.now());
      expect(orders[0].status).toBe('REFUNDED');
    });

    it('token không có trong hệ thống → false, không ném', async () => {
      expect(await service.revoke('khong-co', 'x')).toBe(false);
    });
  });

  describe('handleNotification — RTDN', () => {
    const push = (msg: object) => ({
      message: { data: Buffer.from(JSON.stringify(msg)).toString('base64') },
    });
    const PKG = { packageName: 'com.tripmate.app' };

    it('hoàn tiền (voidedPurchaseNotification) → thu hồi', async () => {
      await service.apply(USER, 'tok', sub(), 'test');
      const r = await service.handleNotification(
        push({ ...PKG, voidedPurchaseNotification: { purchaseToken: 'tok', orderId: 'GPA.1111-2222-3333-44444', productType: 1 } }),
      );
      expect(r.note).toBe('revoked');
      expect(subs[0].status).toBe('CANCELED');
    });

    it('gói khác package → bỏ qua', async () => {
      const r = await service.handleNotification(
        push({ packageName: 'com.khac', voidedPurchaseNotification: { purchaseToken: 'tok' } }),
      );
      expect(r.note).toBe('other-package');
    });

    it('thông báo gia hạn: tra lại Google rồi đồng bộ (không tin nội dung thông báo)', async () => {
      jest.spyOn(service, 'fetchSubscription').mockResolvedValue(sub());
      const r = await service.handleNotification(
        push({ ...PKG, subscriptionNotification: { notificationType: 2, purchaseToken: 'tok' } }),
      );
      // Chưa có dòng nào: chủ biên lai lấy từ obfuscatedExternalAccountId.
      expect(r.note).toBe('synced:ACTIVE');
      expect(subs[0].userId).toBe(USER);
    });

    it('chủ biên lai không xác định → bỏ qua, không cấp cho ai', async () => {
      jest
        .spyOn(service, 'fetchSubscription')
        .mockResolvedValue(sub({ externalAccountIdentifiers: {} }));
      const r = await service.handleNotification(
        push({ ...PKG, subscriptionNotification: { purchaseToken: 'tok' } }),
      );
      expect(r.note).toBe('owner-unknown');
      expect(subs).toHaveLength(0);
    });

    it('Google không trả lời → retry để Pub/Sub gửi lại', async () => {
      jest.spyOn(service, 'fetchSubscription').mockRejectedValue(new Error('ETIMEDOUT'));
      const r = await service.handleNotification(
        push({ ...PKG, subscriptionNotification: { purchaseToken: 'tok' } }),
      );
      expect(r).toMatchObject({ ok: false, retry: true });
    });

    it('Google nói token sai (4xx) → không retry vô hạn', async () => {
      jest.spyOn(service, 'fetchSubscription').mockRejectedValue(new PlayReceiptRejected(410, 'gone'));
      const r = await service.handleNotification(
        push({ ...PKG, subscriptionNotification: { purchaseToken: 'tok' } }),
      );
      expect(r).toMatchObject({ ok: true, note: 'google-410' });
    });

    it('payload rác → không ném', async () => {
      expect((await service.handleNotification({ message: { data: '!!!' } })).ok).toBe(true);
      expect((await service.handleNotification(undefined)).ok).toBe(true);
    });
  });

  describe('verifyPush — chặn RTDN giả mạo', () => {
    const saved = { ...process.env };
    afterEach(() => (process.env = { ...saved }));

    it('chưa cấu hình audience/email → từ chối tất cả', async () => {
      delete process.env.PLAY_RTDN_AUDIENCE;
      delete process.env.PLAY_RTDN_SA_EMAIL;
      expect(await service.verifyPush('Bearer abc')).toBe(false);
    });

    it('có cấu hình nhưng không có / sai token → từ chối', async () => {
      process.env.PLAY_RTDN_AUDIENCE = 'https://api/x';
      process.env.PLAY_RTDN_SA_EMAIL = 'rtdn@p.iam.gserviceaccount.com';
      expect(await service.verifyPush(undefined)).toBe(false);
      expect(await service.verifyPush('Bearer khong.phai.jwt')).toBe(false);
    });
  });

  it('mapState: trạng thái lạ → null', () => {
    expect(GooglePlayBillingService.mapState('X', new Date(), new Date())).toBeNull();
  });
});
