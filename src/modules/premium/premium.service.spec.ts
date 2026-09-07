import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';

import { PremiumService } from './premium.service';
import { EntitlementService } from './entitlement.service';
import { PaymentGatewayService } from './payment-gateway.service';
import { TrialService } from './trial.service';
import { PromoService } from './promo.service';
import { ReferralService } from './referral.service';
import { PrismaService } from '../../prisma/prisma.service';
import { priceOf, MONTHLY_PRICE } from './pricing';

/**
 * Trọng tâm: **webhook không được cấp gói khi số tiền không khớp đơn**.
 *
 * Trước khi có bảng `PaymentOrder`, `fulfill()` chỉ còn biết tin vào chính mã
 * đơn — mà mã đơn tự mang `plan` và `months`. Ai dựng được một giao dịch
 * 1.000đ mang mã `tmsub.<id>.SQUAD.12` là nhận trọn một năm Squad.
 */
describe('PremiumService — đơn hàng và webhook', () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const MOMO_SECRET = 'test-momo-secret';

  let service: PremiumService;
  let prisma: any;
  let entitlements: any;
  let gateways: any;
  let trials: any;
  let promos: any;

  /** Ký IPN Momo đúng như cổng thật, để test đi qua được cửa chữ ký. */
  function signMomo(p: Record<string, unknown>) {
    const s = (v: unknown): string =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : '';
    const raw =
      `accessKey=${process.env.MOMO_ACCESS_KEY ?? ''}` +
      `&amount=${s(p.amount)}` +
      `&extraData=${s(p.extraData)}` +
      `&message=${s(p.message)}` +
      `&orderId=${s(p.orderId)}` +
      `&orderInfo=${s(p.orderInfo)}` +
      `&orderType=${s(p.orderType)}` +
      `&partnerCode=${s(p.partnerCode)}` +
      `&payType=${s(p.payType)}` +
      `&requestId=${s(p.requestId)}` +
      `&responseTime=${s(p.responseTime)}` +
      `&resultCode=${s(p.resultCode)}` +
      `&transId=${s(p.transId)}`;
    return createHmac('sha256', MOMO_SECRET).update(raw).digest('hex');
  }

  function momoIpn(over: Record<string, unknown>) {
    const p: Record<string, unknown> = {
      amount: 0,
      extraData: '',
      message: 'Successful.',
      orderId: '',
      orderInfo: 'TripMate',
      orderType: 'momo_wallet',
      partnerCode: 'TEST',
      payType: 'qr',
      requestId: 'req-1',
      responseTime: 1,
      resultCode: 0,
      transId: 999,
      ...over,
    };
    return { ...p, signature: signMomo(p) };
  }

  beforeEach(async () => {
    process.env.MOMO_SECRET_KEY = MOMO_SECRET;
    process.env.MOMO_ACCESS_KEY = 'test-access';

    prisma = {
      paymentOrder: {
        create: jest.fn(async ({ data }: any) => data),
        findUnique: jest.fn(),
        update: jest.fn(async (a: any) => a),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
      paymentTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    entitlements = { grant: jest.fn(), of: jest.fn(), cancel: jest.fn() };
    gateways = {
      availableGateways: jest.fn().mockReturnValue(['MOMO', 'ZALOPAY']),
      create: jest.fn().mockResolvedValue({ payUrl: 'https://pay/x' }),
    };

    trials = { markConverted: jest.fn(), log: jest.fn() };
    promos = { validate: jest.fn(), redeem: jest.fn(), listActive: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PremiumService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementService, useValue: entitlements },
        { provide: PaymentGatewayService, useValue: gateways },
        { provide: TrialService, useValue: trials },
        { provide: PromoService, useValue: promos },
        { provide: ReferralService, useValue: {} },
      ],
    }).compile();
    service = mod.get(PremiumService);
  });

  describe('createOrder', () => {
    it('chốt giá ở server, không nhận số tiền từ client', async () => {
      const res = await service.createOrder(USER, 'PLUS', 1, 'MOMO');
      expect(res.amount).toBe(MONTHLY_PRICE.PLUS);
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: MONTHLY_PRICE.PLUS }),
        }),
      );
    });

    it('giảm giá khi trả trước 12 tháng', async () => {
      const res = await service.createOrder(USER, 'SQUAD', 12, 'ZALOPAY');
      expect(res.amount).toBe(priceOf('SQUAD', 12));
      expect(res.amount).toBeLessThan(MONTHLY_PRICE.SQUAD * 12);
    });

    it('từ chối gói không bán được', async () => {
      await expect(
        service.createOrder(USER, 'FREE', 1, 'MOMO'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createOrder(USER, 'ENTERPRISE', 1, 'MOMO'),
      ).rejects.toThrow(BadRequestException);
    });

    it('từ chối kỳ hạn không nằm trong bảng giá', async () => {
      await expect(
        service.createOrder(USER, 'PLUS', 3, 'MOMO'),
      ).rejects.toThrow(BadRequestException);
    });

    it('áp mã giảm giá vào SỐ TIỀN THẬT của đơn', async () => {
      // Bản trước trả về `discount` rồi không dùng tới ở đâu: người dùng thấy
      // "giảm 50%" và trả nguyên giá.
      promos.validate.mockResolvedValue({
        code: 'GIAM50',
        description: 'Giảm nửa giá',
        discount: 19000,
        total: MONTHLY_PRICE.PLUS - 19000,
      });
      const res = await service.createOrder(USER, 'PLUS', 1, 'MOMO', 'giam50');

      expect(res.amount).toBe(MONTHLY_PRICE.PLUS - 19000);
      expect(res.baseAmount).toBe(MONTHLY_PRICE.PLUS);
      expect(res.discount).toBe(19000);
      // Số tiền gửi sang cổng phải là số ĐÃ giảm, không phải giá gốc.
      expect(gateways.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: MONTHLY_PRICE.PLUS - 19000 }),
      );
    });

    it('mã hỏng làm hỏng cả đơn, không âm thầm thu đủ tiền', async () => {
      promos.validate.mockRejectedValue(
        new BadRequestException({ code: 'PROMO_EXPIRED' }),
      );
      await expect(
        service.createOrder(USER, 'PLUS', 1, 'MOMO', 'hethan'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    it('đóng đơn lại khi cổng từ chối tạo', async () => {
      gateways.create.mockRejectedValueOnce(new Error('gateway down'));
      await expect(
        service.createOrder(USER, 'PLUS', 1, 'MOMO'),
      ).rejects.toThrow();
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  describe('webhook Momo', () => {
    const ORDER = `tmsub.${USER}.SQUAD.12.1700000000000`;

    function pendingOrder(over: Record<string, unknown> = {}) {
      return {
        orderId: ORDER,
        userId: USER,
        plan: 'SQUAD',
        months: 12,
        amount: priceOf('SQUAD', 12),
        provider: 'MOMO',
        status: 'PENDING',
        ...over,
      };
    }

    it('từ chối chữ ký sai', async () => {
      await expect(
        service.handleMomoIpn({ orderId: ORDER, signature: 'deadbeef' }),
      ).rejects.toThrow(BadRequestException);
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('KHÔNG cấp gói khi số tiền không khớp đơn', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(pendingOrder());
      await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: 1000 }),
      );
      expect(entitlements.grant).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failureReason: 'AMOUNT_MISMATCH' }),
        }),
      );
    });

    it('cấp gói khi số tiền khớp', async () => {
      const order = pendingOrder();
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: order.amount }),
      );
      expect(entitlements.grant).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          plan: 'SQUAD',
          months: 12,
          provider: 'MOMO',
        }),
      );
    });

    it('dùng plan/months của ĐƠN, không dùng giá trị đọc từ mã đơn', async () => {
      // Mã đơn nói SQUAD 12 tháng, nhưng đơn thật trong DB là PLUS 1 tháng.
      const order = pendingOrder({
        plan: 'PLUS',
        months: 1,
        amount: MONTHLY_PRICE.PLUS,
      });
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: MONTHLY_PRICE.PLUS }),
      );
      expect(entitlements.grant).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'PLUS', months: 1 }),
      );
    });

    it('ghi lượt dùng mã CHỈ khi đơn đã thanh toán thành công', async () => {
      const order = pendingOrder({ promoCode: 'GIAM50', discountAmount: 19000 });
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: order.amount }),
      );
      expect(promos.redeem).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'GIAM50',
          userId: USER,
          discountApplied: 19000,
        }),
      );
    });

    it('không ghi lượt dùng mã khi số tiền sai', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(
        pendingOrder({ promoCode: 'GIAM50', discountAmount: 19000 }),
      );
      await service.handleMomoIpn(momoIpn({ orderId: ORDER, amount: 1000 }));
      expect(promos.redeem).not.toHaveBeenCalled();
    });

    it('không có đơn thì không cấp gì', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(null);
      await service.handleMomoIpn(momoIpn({ orderId: ORDER, amount: 1 }));
      expect(entitlements.grant).not.toHaveBeenCalled();
    });

    it('gọi lại nhiều lần chỉ cấp một lần', async () => {
      const order = pendingOrder();
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      const ipn = momoIpn({ orderId: ORDER, amount: order.amount });

      await service.handleMomoIpn(ipn);
      // Lần hai: đơn đã SUCCESS.
      prisma.paymentOrder.findUnique.mockResolvedValue({
        ...order,
        status: 'SUCCESS',
      });
      await service.handleMomoIpn(ipn);

      expect(entitlements.grant).toHaveBeenCalledTimes(1);
    });

    it('ghi nhận thất bại khi Momo báo lỗi', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(pendingOrder());
      await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: 1, resultCode: 1006 }),
      );
      expect(entitlements.grant).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failureReason: 'MOMO_1006' }),
        }),
      );
    });

    it('không cấp gói khi tiến trình khác đã giành xử lý đơn trước (race condition)', async () => {
      const order = pendingOrder();
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });

      const res = await service.handleMomoIpn(
        momoIpn({ orderId: ORDER, amount: order.amount }),
      );

      expect(entitlements.grant).not.toHaveBeenCalled();
      expect(res).toEqual({
        resultCode: 0,
        message: 'IPN processed successfully',
      });
    });

    it('chuyển trạng thái đơn sang SUCCESS với điều kiện PENDING và cấp quyền đúng 1 lần', async () => {
      const order = pendingOrder();
      prisma.paymentOrder.findUnique.mockResolvedValue(order);

      await service.handleMomoIpn(
        momoIpn({
          orderId: ORDER,
          amount: order.amount,
          transId: 'momo-trans-999',
        }),
      );

      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orderId: ORDER,
            status: 'PENDING',
          }),
          data: expect.objectContaining({
            status: 'SUCCESS',
            externalId: 'momo-trans-999',
            paidAt: expect.any(Date),
          }),
        }),
      );
      expect(entitlements.grant).toHaveBeenCalledTimes(1);
    });

    it('rollback đơn về PENDING và ném lỗi ra ngoài khi cấp quyền thất bại để cổng retry', async () => {
      const order = pendingOrder();
      prisma.paymentOrder.findUnique.mockResolvedValue(order);
      entitlements.grant.mockRejectedValue(new Error('Lỗi cấp quyền nội bộ'));

      await expect(
        service.handleMomoIpn(
          momoIpn({ orderId: ORDER, amount: order.amount }),
        ),
      ).rejects.toThrow('Lỗi cấp quyền nội bộ');

      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: ORDER },
          data: expect.objectContaining({
            status: 'PENDING',
            paidAt: null,
            failureReason: expect.stringContaining(
              'GRANT_FAILED: Lỗi cấp quyền nội bộ',
            ),
          }),
        }),
      );
    });
  });

  describe('getOrder', () => {
    it('không tiết lộ đơn của người khác', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue({
        orderId: 'x',
        userId: 'someone-else',
      });
      await expect(service.getOrder(USER, 'x')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
