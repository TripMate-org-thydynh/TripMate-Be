import { Test, TestingModule } from '@nestjs/testing';
import { TrialEligibilityService } from './trial-eligibility.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Trọng tâm: **không chặn oan**.
 *
 * Cách hỏng đắt nhất của một tầng chống lạm dụng không phải là để lọt vài
 * người gian — đó chỉ là mất ba ngày bản trả phí. Đắt hơn nhiều là chặn người
 * thật, vì họ không khiếu nại, họ chỉ bỏ đi. Nên phần lớn test ở đây kiểm
 * chiều đó: dùng chung IP, dùng chung máy một lần, tài khoản vừa tạo — đều
 * KHÔNG được thành `INELIGIBLE`.
 */
describe('TrialEligibilityService', () => {
  const USER = 'user-1';
  let service: TrialEligibilityService;
  let prisma: any;

  beforeEach(async () => {
    process.env.TRIAL_SIGNAL_SALT = 'test-salt';
    prisma = {
      trialClaim: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      paymentOrder: { findFirst: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date(),
          email: 'nguoidung@gmail.com',
        }),
      },
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TrialEligibilityService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(TrialEligibilityService);
  });

  const signals = {
    email: 'nguoidung@gmail.com',
    deviceId: 'device-abc',
    ip: '113.161.40.55',
  };

  describe('chuẩn hoá email', () => {
    it('gmail: bỏ dấu chấm và phần sau dấu +', () => {
      expect(service.normalizeEmail('a.b+khuyenmai@gmail.com')).toBe(
        'ab@gmail.com',
      );
      expect(service.normalizeEmail('A.B@googlemail.com')).toBe(
        'ab@gmail.com',
      );
    });

    it('tên miền khác: chỉ bỏ phần sau dấu +, GIỮ dấu chấm', () => {
      // Nhiều nhà cung cấp coi `a.b@` và `ab@` là hai hộp thư khác nhau. Bỏ
      // dấu chấm với mọi tên miền là gộp nhầm hai người thật thành một.
      expect(service.normalizeEmail('a.b+x@outlook.com')).toBe(
        'a.b@outlook.com',
      );
    });
  });

  describe('bằng chứng chắc chắn → INELIGIBLE', () => {
    it('chính tài khoản này đã dùng thử', async () => {
      prisma.trialClaim.findFirst.mockResolvedValueOnce({ id: 'c1' });
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('INELIGIBLE');
      expect(r.reasons).toEqual(['ALREADY_TRIALED']);
    });

    it('đã từng trả tiền thì không còn là đối tượng dùng thử', async () => {
      prisma.paymentOrder.findFirst.mockResolvedValueOnce({ id: 'o1' });
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('INELIGIBLE');
      expect(r.reasons).toEqual(['ALREADY_PAID']);
    });

    it('cùng hộp thư (khác biến thể) đã dùng thử', async () => {
      // Lần findFirst đầu là "chính tài khoản này" → null; lần sau là "cùng
      // emailHash" → có.
      prisma.trialClaim.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'c2' });
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('INELIGIBLE');
      expect(r.reasons).toContain('EMAIL_ALREADY_TRIALED');
    });
  });

  describe('KHÔNG chặn oan', () => {
    it('dùng chung IP một mình không đủ để chặn hay soi', async () => {
      // Cả một ký túc xá hay một nhà mạng NAT sau cùng một dải là bình thường.
      prisma.trialClaim.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.networkHash ? 50 : 0),
      );
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('ELIGIBLE');
    });

    it('thiếu deviceId không bị coi là dấu hiệu xấu', async () => {
      const r = await service.evaluate(USER, { ...signals, deviceId: null });
      expect(r.verdict).toBe('ELIGIBLE');
      expect(r.reasons).toContain('NO_DEVICE_SIGNAL');
    });

    it('tài khoản vừa tạo xong xin dùng thử là bình thường', async () => {
      prisma.user.findUnique.mockResolvedValue({
        createdAt: new Date(),
        email: 'moitoanh@gmail.com',
      });
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('ELIGIBLE');
    });

    it('máy dùng chung trong nhà (1 lần trước đó) chỉ bị soi, vẫn được thử', async () => {
      prisma.trialClaim.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.deviceHash ? 1 : 0),
      );
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('REVIEW');
      expect(r.reasons).toContain('DEVICE_SEEN_BEFORE');
    });
  });

  describe('mẫu lạm dụng thật', () => {
    it('nhiều tài khoản trên cùng một máy → chặn', async () => {
      prisma.trialClaim.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.deviceHash ? 3 : 0),
      );
      const r = await service.evaluate(USER, signals);
      expect(r.verdict).toBe('INELIGIBLE');
      expect(r.reasons).toContain('DEVICE_MULTIPLE_TRIALS');
    });

    it('email dùng-một-lần + máy đã thấy trước → chặn', async () => {
      prisma.user.findUnique.mockResolvedValue({
        createdAt: new Date(),
        email: 'abc@mailinator.com',
      });
      prisma.trialClaim.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.deviceHash ? 1 : 0),
      );
      const r = await service.evaluate(USER, {
        ...signals,
        email: 'abc@mailinator.com',
      });
      expect(r.verdict).toBe('INELIGIBLE');
      expect(r.reasons).toEqual(
        expect.arrayContaining(['DISPOSABLE_EMAIL', 'DEVICE_SEEN_BEFORE']),
      );
    });

    it('email dùng-một-lần một mình chỉ đủ để soi', async () => {
      prisma.user.findUnique.mockResolvedValue({
        createdAt: new Date(),
        email: 'abc@yopmail.com',
      });
      const r = await service.evaluate(USER, {
        ...signals,
        email: 'abc@yopmail.com',
      });
      expect(r.verdict).toBe('REVIEW');
    });
  });

  describe('quyền riêng tư', () => {
    it('không lưu IP hay device id thô, chỉ lưu băm', async () => {
      const r = await service.evaluate(USER, signals);
      const all = JSON.stringify(r.hashes);
      expect(all).not.toContain('113.161.40.55');
      expect(all).not.toContain('113.161.40');
      expect(all).not.toContain('device-abc');
      expect(all).not.toContain('nguoidung');
      expect(r.hashes.emailHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('băm mạng theo dải /24: cùng dải ra cùng băm, khác dải ra khác', async () => {
      const a = await service.evaluate(USER, { ...signals, ip: '1.2.3.4' });
      const b = await service.evaluate(USER, { ...signals, ip: '1.2.3.200' });
      const c = await service.evaluate(USER, { ...signals, ip: '1.2.9.4' });
      expect(a.hashes.networkHash).toBe(b.hashes.networkHash);
      expect(a.hashes.networkHash).not.toBe(c.hashes.networkHash);
    });

    it('các biến thể của cùng hộp thư gmail ra cùng băm', async () => {
      const a = await service.evaluate(USER, {
        ...signals,
        email: 'ab@gmail.com',
      });
      const b = await service.evaluate(USER, {
        ...signals,
        email: 'A.B+giamgia@gmail.com',
      });
      expect(a.hashes.emailHash).toBe(b.hashes.emailHash);
    });
  });
});
