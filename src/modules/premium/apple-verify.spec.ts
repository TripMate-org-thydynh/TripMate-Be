import { BadRequestException } from '@nestjs/common';
import { PremiumService } from './premium.service';

/**
 * Mua bằng Apple: quyền chỉ được cấp khi APPLE xác nhận biên lai. Trước đây
 * thiếu receiptData là bỏ qua kiểm tra và tin transactionId/productId client gửi.
 */
describe('PremiumService — xác minh mua hàng Apple', () => {
  const env = { ...process.env };
  let svc: any;
  let prisma: any;

  const appleReply = (over: object = {}) => ({
    status: 0,
    receipt: { bundle_id: 'com.tripmate.tripmate', in_app: [] },
    latest_receipt_info: [
      {
        transaction_id: '2000000111',
        product_id: 'tripmate_plus_monthly',
        purchase_date_ms: String(Date.now() - 1000),
        expires_date_ms: String(Date.now() + 30 * 864e5),
      },
    ],
    ...over,
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_APP_STORE_SHARED_SECRET = 'secret';
    delete process.env.MOCK_APPLE_APP_STORE;
    delete process.env.APPLE_BUNDLE_ID;
    prisma = {
      paymentOrder: { findFirst: jest.fn().mockResolvedValue(null) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    svc = Object.create(PremiumService.prototype);
    svc.prisma = prisma;
    svc.resolveStoreProduct = (id?: string) =>
      id === 'tripmate_plus_monthly' ? { plan: 'PLUS', months: 1 } : null;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const mockApple = (reply: object) => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ json: async () => reply }) as any;
  };

  it('không có biên lai → từ chối, không gọi tới bước cấp quyền', async () => {
    mockApple(appleReply());
    await expect(
      svc.verifyApplePurchase('u1', {
        transactionId: 'random-123',
        productId: 'tripmate_plus_monthly',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.paymentOrder.findFirst).not.toHaveBeenCalled();
  });

  it('Apple trả status khác 0 → từ chối', async () => {
    mockApple({ status: 21003 });
    await expect(
      svc.verifyAppleReceipt('receipt', 'secret'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('biên lai của app khác (bundle id lệch) → từ chối', async () => {
    mockApple(
      appleReply({ receipt: { bundle_id: 'com.other.app', in_app: [] } }),
    );
    await expect(
      svc.verifyAppleReceipt('receipt', 'secret'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('transactionId client tự bịa không có trong biên lai → từ chối', async () => {
    mockApple(appleReply());
    await expect(
      svc.verifyAppleReceipt('receipt', 'secret', 'fake-tx'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lấy transaction + product từ phản hồi Apple', async () => {
    mockApple(appleReply());
    await expect(svc.verifyAppleReceipt('receipt', 'secret')).resolves.toEqual({
      transactionId: '2000000111',
      productId: 'tripmate_plus_monthly',
    });
  });

  it('gói đã hết hạn không đổi được kỳ mới', async () => {
    mockApple(
      appleReply({
        latest_receipt_info: [
          {
            transaction_id: '1',
            product_id: 'tripmate_plus_monthly',
            purchase_date_ms: '1',
            expires_date_ms: String(Date.now() - 1000),
          },
        ],
      }),
    );
    await expect(
      svc.verifyAppleReceipt('receipt', 'secret'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
