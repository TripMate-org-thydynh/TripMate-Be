import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';

import { PremiumService } from './premium.service';
import { EntitlementService } from './entitlement.service';
import { PaymentGatewayService } from './payment-gateway.service';
import { TrialService } from './trial.service';
import { PromoService } from './promo.service';
import { ReferralService } from './referral.service';
import { PrismaService } from '../../prisma/prisma.service';
import { priceOf } from './pricing';
import { playProductOf, playProductIdFor, PLAY_PRODUCTS } from './google-play';

/**
 * Hai kênh bán: quét mã VietQR qua SePay, và Google Play Billing.
 *
 * Ba thứ được canh ở đây, đều là lỗi đã thật sự tồn tại trong mã nguồn:
 *
 * 1. Mã sản phẩm Play suy ra gói bằng `includes()` — `tripmate_squad_yearly`
 *    khớp `'squad'` trước `'yearly'` nên người mua gói năm nhận một tháng.
 * 2. `checkout()` có bảng giá riêng lệch với bảng giá thật, nên số tiền trên mã
 *    QR khác số tiền người dùng vừa nhìn thấy trên màn hình.
 * 3. Tài khoản nhận tiền SePay có giá trị mặc định là số tài khoản cá nhân —
 *    quên cấu hình lúc lên thật là tiền của khách chảy vào đó.
 */
describe('Kênh thanh toán — SePay và Google Play', () => {
  const USER = '11111111-1111-1111-1111-111111111111';

  const SEPAY_ENV = {
    SEPAY_ACCOUNT_NUMBER: '0123456789',
    SEPAY_BANK_CODE: 'MBBank',
    SEPAY_ACCOUNT_NAME: 'CONG TY TRIPMATE',
  };

  let service: PremiumService;
  let prisma: any;
  let gateways: any;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env = { ...savedEnv, ...SEPAY_ENV };
    delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    delete process.env.MOCK_GOOGLE_PLAY;
    delete process.env.USER_CHOICE_BILLING;

    prisma = {
      paymentOrder: {
        create: jest.fn(async ({ data }: any) => data),
        // Mã đơn nào cũng còn trống, để `newSepayOrderCode` nhận ngay lần đầu.
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(async (a: any) => a),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
      paymentTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    gateways = {
      availableGateways: jest.fn().mockReturnValue(['MOMO', 'ZALOPAY']),
      create: jest.fn().mockResolvedValue({ payUrl: 'https://pay/x' }),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PremiumService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementService, useValue: { grant: jest.fn() } },
        { provide: PaymentGatewayService, useValue: gateways },
        { provide: TrialService, useValue: { markConverted: jest.fn(), log: jest.fn() } },
        { provide: PromoService, useValue: { validate: jest.fn(), redeem: jest.fn() } },
        { provide: ReferralService, useValue: {} },
      ],
    }).compile();
    service = mod.get(PremiumService);
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('danh mục sản phẩm Google Play', () => {
    it('gói năm ra 12 tháng, không phải 1', () => {
      // Đây là hồi quy: bản cũ dùng `productId.includes('squad')` trước
      // `includes('yearly')`, nên chuỗi này ra SQUAD/1 tháng. Khách trả
      // 950.000đ và mất 11 tháng mà không có cách nào biết.
      expect(playProductOf('tripmate_squad_yearly')).toEqual({
        plan: 'SQUAD',
        months: 12,
      });
      expect(playProductOf('tripmate_plus_yearly')).toEqual({
        plan: 'PLUS',
        months: 12,
      });
    });

    it('gói tháng ra đúng 1 tháng', () => {
      expect(playProductOf('tripmate_plus_monthly')).toEqual({
        plan: 'PLUS',
        months: 1,
      });
      expect(playProductOf('tripmate_squad_monthly')).toEqual({
        plan: 'SQUAD',
        months: 1,
      });
    });

    it('mã lạ trả về null chứ không đoán bừa', () => {
      // Bản cũ không có nhánh nào trả về "không biết": mọi chuỗi lạ đều rơi vào
      // `else` và được cấp PLUS 1 tháng — kể cả chuỗi rỗng.
      expect(playProductOf('tripmate_squad_weekly')).toBeNull();
      expect(playProductOf('')).toBeNull();
      expect(playProductOf(undefined)).toBeNull();
      expect(playProductOf(123)).toBeNull();
    });

    it('tra ngược từ (gói, kỳ hạn) ra mã sản phẩm', () => {
      expect(playProductIdFor('SQUAD', 12)).toBe('tripmate_squad_yearly');
      expect(playProductIdFor('PLUS', 1)).toBe('tripmate_plus_monthly');
      // Kỳ hạn không bán trên Play thì không có mã, và phải nói thẳng là không có.
      expect(playProductIdFor('PLUS', 3)).toBeNull();
    });

    it('mọi sản phẩm Play đều có giá trong bảng giá của server', () => {
      // Hai kênh bán phải bán cùng một tập hàng. Lệch nhau thì có gói mua được
      // qua Play mà không mua được qua VietQR.
      for (const p of Object.values(PLAY_PRODUCTS)) {
        expect(() => priceOf(p.plan, p.months)).not.toThrow();
      }
    });
  });

  describe('lọc cổng theo kênh phân phối', () => {
    it('bản CH Play chỉ thấy Play Billing, không thấy VietQR', () => {
      // Chính sách Payments của Google: hàng hoá số tiêu thụ trong app phải qua
      // Play Billing. Việt Nam chưa được mở "User Choice Billing", nên bày SePay
      // cạnh Play Billing là đường ngắn nhất tới việc bị gỡ app.
      process.env.MOCK_GOOGLE_PLAY = 'true';
      process.env.NODE_ENV = 'test';
      expect(service.gatewaysFor('play')).toEqual(['GOOGLE_PLAY']);
    });

    it('bật USER_CHOICE_BILLING thì bản CH Play thấy cả hai', () => {
      // Khi nào VN vào chương trình của Google thì bật cờ này là xong, không
      // phải sửa dòng code nào.
      process.env.MOCK_GOOGLE_PLAY = 'true';
      process.env.NODE_ENV = 'test';
      process.env.USER_CHOICE_BILLING = 'true';
      expect(service.gatewaysFor('play')).toEqual(['GOOGLE_PLAY', 'SEPAY']);
    });

    it('bản APK/web thấy VietQR và ví, không thấy Play Billing', () => {
      // Ngoài CH Play thì không có thư viện billing để gọi — bày ra là một nút
      // bấm vào không có gì xảy ra.
      expect(service.gatewaysFor('direct')).toEqual(['SEPAY', 'MOMO', 'ZALOPAY']);
      expect(service.gatewaysFor('web')).toEqual(['SEPAY', 'MOMO', 'ZALOPAY']);
    });

    it('thiếu cấu hình tài khoản nhận tiền thì không bày VietQR', () => {
      delete process.env.SEPAY_ACCOUNT_NUMBER;
      expect(service.gatewaysFor('direct')).toEqual(['MOMO', 'ZALOPAY']);
    });

    it('không khai kênh thì coi như CH Play', () => {
      // Đoán sai theo hướng này: người dùng thiếu một lựa chọn thanh toán.
      // Đoán sai theo hướng kia: app bị gỡ khỏi cửa hàng.
      process.env.MOCK_GOOGLE_PLAY = 'true';
      process.env.NODE_ENV = 'test';
      expect(service.plans(undefined).channel).toBe('play');
      expect(service.plans('linh tinh').channel).toBe('play');
      expect(service.plans('web').channel).toBe('web');
    });

    it('bảng giá kèm mã sản phẩm Play cho từng kỳ hạn', () => {
      const plus = service.plans('play').plans.find((p) => p.plan === 'PLUS')!;
      const yearly = plus.terms.find((t) => t.months === 12)!;
      expect(yearly.playProductId).toBe('tripmate_plus_yearly');
      expect(yearly.total).toBe(priceOf('PLUS', 12));
    });
  });

  describe('đơn VietQR qua SePay', () => {
    it('mã đơn ngắn, chỉ gồm chữ cái không gây đọc nhầm', async () => {
      const res: any = await service.createOrder(USER, 'PLUS', 1, 'SEPAY');
      // Người dùng phải gõ tay mã này vào ô nội dung chuyển khoản khi app ngân
      // hàng không tự điền được, nên bảng chữ cái bỏ 0/O và 1/I.
      expect(res.orderId).toMatch(/^TM[2-9A-HJ-NP-Z]{6}$/);
      expect(res.orderCode).toBe(res.orderId);
    });

    it('lấy giá từ bảng giá chung, giống hệt đường ví', async () => {
      const qr: any = await service.createOrder(USER, 'SQUAD', 12, 'SEPAY');
      const wallet: any = await service.createOrder(USER, 'SQUAD', 12, 'MOMO');
      expect(qr.amount).toBe(priceOf('SQUAD', 12));
      expect(qr.amount).toBe(wallet.amount);
    });

    it('ghi vào bảng đơn hàng nên lịch sử hoá đơn thấy được', async () => {
      // Bản cũ ghi vào `PaymentTransaction`, còn lịch sử hoá đơn đọc
      // `PaymentOrder` — người trả tiền bằng QR không bao giờ thấy hoá đơn.
      await service.createOrder(USER, 'PLUS', 1, 'SEPAY');
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER,
            plan: 'PLUS',
            months: 1,
            provider: 'SEPAY',
            amount: priceOf('PLUS', 1),
          }),
        }),
      );
    });

    it('QR mang đúng tài khoản đã cấu hình và mã đơn làm nội dung', async () => {
      const res: any = await service.createOrder(USER, 'PLUS', 1, 'SEPAY');
      expect(res.bankInfo).toEqual({
        bankCode: 'MBBank',
        accountNumber: '0123456789',
        accountName: 'CONG TY TRIPMATE',
        amount: priceOf('PLUS', 1),
        transferContent: res.orderCode,
      });
      expect(res.qrUrl).toContain('acc=0123456789');
      expect(res.qrUrl).toContain(`des=${res.orderCode}`);
    });

    it('thiếu cấu hình tài khoản thì từ chối bán, không rơi về số mặc định', async () => {
      // Bản cũ mặc định về số tài khoản cá nhân của một thành viên trong nhóm.
      // Thiếu cấu hình phải là "không bán được", không phải "bán vào nhầm túi".
      delete process.env.SEPAY_ACCOUNT_NUMBER;
      await expect(
        service.createOrder(USER, 'PLUS', 1, 'SEPAY'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('xác thực biên lai Google Play (chế độ giả lập)', () => {
    let entitlements: any;

    beforeEach(async () => {
      process.env.MOCK_GOOGLE_PLAY = 'true';
      process.env.NODE_ENV = 'test';
      entitlements = { grant: jest.fn() };
      const mod: TestingModule = await Test.createTestingModule({
        providers: [
          PremiumService,
          { provide: PrismaService, useValue: prisma },
          { provide: EntitlementService, useValue: entitlements },
          { provide: PaymentGatewayService, useValue: gateways },
          {
            provide: TrialService,
            useValue: { markConverted: jest.fn(), log: jest.fn() },
          },
          {
            provide: PromoService,
            useValue: { validate: jest.fn(), redeem: jest.fn() },
          },
          { provide: ReferralService, useValue: {} },
        ],
      }).compile();
      service = mod.get(PremiumService);
    });

    it('gói năm cấp 12 tháng và ghi nhận PaymentOrder cho lịch sử hoá đơn', async () => {
      const res: any = await service.verifyGooglePlayPurchase(
        USER,
        'tok-1',
        'tripmate_squad_yearly',
      );
      expect(res.months).toBe(12);
      expect(entitlements.grant).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'SQUAD', months: 12 }),
      );
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER,
            plan: 'SQUAD',
            provider: 'GOOGLE_PLAY',
            status: 'SUCCESS',
            externalId: 'tok-1',
          }),
        }),
      );
    });

    it('biên lai đã dùng thì KHÔNG cấp thêm lần nữa', async () => {
      // Đây là lỗi tự tay tạo ra rồi bắt được khi chạy thật: chốt chống trùng
      // ban đầu nằm SAU nhánh giả lập, nên gửi lại cùng một biên lai cộng thêm
      // trọn một năm. Google phát lại biên lai mỗi lần app khởi động, nên đây
      // không phải tình huống hiếm — nó xảy ra hằng ngày.
      prisma.subscription.findFirst.mockResolvedValue({
        userId: USER,
        plan: 'SQUAD',
        currentPeriodEnd: new Date('2027-01-01'),
      });
      const res: any = await service.verifyGooglePlayPurchase(
        USER,
        'tok-1',
        'tripmate_squad_yearly',
      );
      expect(res.alreadyProcessed).toBe(true);
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('chống cấp trùng biên lai qua PaymentOrder (idempotency lịch sử)', async () => {
      prisma.paymentOrder.findFirst.mockResolvedValue({
        userId: USER,
        plan: 'SQUAD',
        status: 'SUCCESS',
        externalId: 'tok-seen-order',
      });
      const res: any = await service.verifyGooglePlayPurchase(
        USER,
        'tok-seen-order',
        'tripmate_squad_yearly',
      );
      expect(res.alreadyProcessed).toBe(true);
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('biên lai của người khác thì từ chối, không cấp cho người đang hỏi', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        userId: 'nguoi-khac',
        plan: 'SQUAD',
        currentPeriodEnd: new Date('2027-01-01'),
      });
      await expect(
        service.verifyGooglePlayPurchase(USER, 'tok-1', 'tripmate_plus_monthly'),
      ).rejects.toThrow();
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('mã sản phẩm không có trong danh mục thì từ chối', async () => {
      // Bản cũ rơi vào `else` và cấp PLUS 1 tháng cho mọi chuỗi lạ.
      await expect(
        service.verifyGooglePlayPurchase(USER, 'tok-2', 'elite_squad_monthly'),
      ).rejects.toThrow();
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('thiếu token thì từ chối', async () => {
      await expect(
        service.verifyGooglePlayPurchase(USER, '', 'tripmate_plus_monthly'),
      ).rejects.toThrow();
    });

    it('không có cấu hình và không bật giả lập thì từ chối, không cấp chùa', async () => {
      delete process.env.MOCK_GOOGLE_PLAY;
      await expect(
        service.verifyGooglePlayPurchase(USER, 'tok-3', 'tripmate_plus_monthly'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(entitlements.grant).not.toHaveBeenCalled();
    });
  });

  describe('webhook SePay', () => {
    const TOKEN = 'test-sepay-token';
    const ORDER = {
      orderId: 'TMABC234',
      userId: USER,
      plan: 'SQUAD' as const,
      months: 12,
      amount: priceOf('SQUAD', 12),
      discountAmount: 0,
      promoCode: null,
      status: 'PENDING' as const,
    };

    beforeEach(() => {
      process.env.SEPAY_WEBHOOK_TOKEN = TOKEN;
      prisma.paymentOrder.findUnique.mockImplementation(async (a: any) =>
        a.where.orderId === ORDER.orderId ? { ...ORDER } : null,
      );
    });

    it('thiếu token cấu hình thì từ chối nhận webhook', async () => {
      // Một bí mật có giá trị mặc định trong mã nguồn thì không còn là bí mật.
      // Thiếu cấu hình phải là "không nhận", không phải "chạy với token ai cũng
      // đọc được trong repo".
      delete process.env.SEPAY_WEBHOOK_TOKEN;
      await expect(
        service.handleSepayWebhook({ content: ORDER.orderId }, `Apikey ${TOKEN}`),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('sai token thì từ chối', async () => {
      await expect(
        service.handleSepayWebhook(
          { content: ORDER.orderId, transferAmount: ORDER.amount },
          'Apikey sai-token',
        ),
      ).rejects.toThrow();
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });

    it('trả đúng số tiền thì cấp gói', async () => {
      await service.handleSepayWebhook(
        {
          id: 5001,
          content: `NAP TIEN ${ORDER.orderId} TRIPMATE`,
          transferAmount: ORDER.amount,
          transferType: 'in',
        },
        `Apikey ${TOKEN}`,
      );
      // Giành quyền xử lý bằng cập nhật có điều kiện PENDING -> SUCCESS.
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: ORDER.orderId, status: 'PENDING' },
        }),
      );
    });

    it('trả DƯ vài nghìn vẫn giao hàng', async () => {
      // Chuyển khoản là gõ tay. Từ chối vì thừa 5.000đ thì người dùng vừa mất
      // tiền vừa không có gói.
      await service.handleSepayWebhook(
        {
          id: 5002,
          content: ORDER.orderId,
          transferAmount: ORDER.amount + 5000,
          transferType: 'in',
        },
        `Apikey ${TOKEN}`,
      );
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalled();
    });

    it('trả THIẾU thì giữ đơn PENDING, không đánh hỏng', async () => {
      // Đánh FAILED nghĩa là tiền đã ra khỏi tài khoản người dùng mà mã đơn chết
      // hẳn — chuyển bù thêm cũng không cứu được. Để PENDING thì lần chuyển đúng
      // số tiếp theo vẫn hoàn tất được chính đơn đó.
      await service.handleSepayWebhook(
        {
          id: 5003,
          content: ORDER.orderId,
          transferAmount: 10000,
          transferType: 'in',
        },
        `Apikey ${TOKEN}`,
      );
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('bỏ qua tiền chuyển ĐI khỏi tài khoản', async () => {
      await service.handleSepayWebhook(
        { id: 5004, content: ORDER.orderId, transferType: 'out' },
        `Apikey ${TOKEN}`,
      );
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });

    it('chuyển khoản không mang mã đơn thì bỏ qua êm, không lỗi', async () => {
      // Người khác chuyển tiền vào tài khoản vì lý do không liên quan là chuyện
      // bình thường. Ném lỗi ở đây là bắt SePay gửi lại mãi.
      const res = await service.handleSepayWebhook(
        { id: 5005, content: 'CHUYEN TIEN AN TRUA', transferAmount: 50000 },
        `Apikey ${TOKEN}`,
      );
      expect(res.success).toBe(true);
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('checkout() cũ chỉ còn là lớp chuyển tiếp', () => {
    it('gói năm tính đúng giá niêm yết', async () => {
      // Hồi quy: bản cũ có bảng giá riêng tính PLUS 12 tháng là 299.000đ, trong
      // khi màn hình hiển thị 374.000đ lấy từ `/premium/plans`.
      const res: any = await service.checkout(USER, {
        plan: 'PLUS',
        months: 12,
        paymentMethod: 'SEPAY',
      });
      expect(res.amount).toBe(priceOf('PLUS', 12));
    });

    it('SQUAD năm không còn tính bằng giá tháng nhân 12', async () => {
      const res: any = await service.checkout(USER, {
        tier: 'SQUAD_YEARLY',
        paymentMethod: 'VIETQR',
      });
      expect(res.months).toBe(12);
      expect(res.amount).toBe(priceOf('SQUAD', 12));
      expect(res.amount).toBeLessThan(priceOf('SQUAD', 1) * 12);
    });

    it('VIETQR và BANK_TRANSFER đều là SePay', async () => {
      const a: any = await service.checkout(USER, { paymentMethod: 'VIETQR' });
      const b: any = await service.checkout(USER, {
        paymentMethod: 'BANK_TRANSFER',
      });
      expect(a.provider).toBe('SEPAY');
      expect(b.provider).toBe('SEPAY');
    });

    it('không nhận kỳ hạn không có trong bảng giá', async () => {
      // Bản cũ nhận mọi số tháng và tự nhân giá ra — bán những kỳ hạn không hề
      // tồn tại trên bảng giá.
      await expect(
        service.checkout(USER, { plan: 'PLUS', months: 3 }),
      ).rejects.toThrow();
    });
  });
});
