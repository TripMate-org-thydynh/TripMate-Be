import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { AuthService, normalizeIdentifier } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TwilioService } from './twilio.service';
import { MailService } from './mail.service';

/**
 * Sign in with Apple phải kiểm chữ ký token bằng khoá JWKS của Apple.
 * Trước đây chỉ decode payload → ai cũng giả được token mang email người khác.
 */
describe('AuthService.appleLogin', () => {
  const victim = {
    id: 'victim-id',
    email: 'victim@gmail.com',
    name: 'Victim',
    isLocked: false,
    deletedAt: null,
  };

  const appleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const attackerKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...(appleKey.publicKey.export({ format: 'jwk' }) as object),
    kid: 'apple-kid',
    alg: 'RS256',
    use: 'sig',
  };

  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (
    payload: object,
    key: crypto.KeyObject,
    header: object = { alg: 'RS256', kid: 'apple-kid' },
  ) => {
    const body = `${b64(header)}.${b64(payload)}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(body), key);
    return `${body}.${sig.toString('base64url')}`;
  };
  const claims = (over: object = {}) => ({
    iss: 'https://appleid.apple.com',
    aud: 'com.tripmate.tripmate',
    sub: '001234.abc',
    email: victim.email,
    email_verified: 'true',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  });

  let service: AuthService;
  let prisma: any;

  beforeEach(async () => {
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_BUNDLE_ID;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [jwk] }),
    }) as any;
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(victim),
        create: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: () => 'jwt' } },
        { provide: TwilioService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: CACHE_MANAGER, useValue: {} },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('từ chối token tự ký (giả mạo email nạn nhân)', async () => {
    const forged = sign(claims(), attackerKey.privateKey);
    await expect(
      service.appleLogin({ identityToken: forged } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('từ chối token không có chữ ký (alg none)', async () => {
    const unsigned = `${b64({ alg: 'none' })}.${b64(claims())}.`;
    await expect(
      service.appleLogin({ identityToken: unsigned } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('từ chối token Apple thật nhưng cấp cho app khác', async () => {
    const other = sign(claims({ aud: 'com.other.app' }), appleKey.privateKey);
    await expect(
      service.appleLogin({ identityToken: other } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token Apple thật KHÔNG có email: không dùng email client gửi để vào tài khoản người khác', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'new', ...data }),
    );
    const noEmail = sign(
      claims({ email: undefined, sub: 'attacker.sub' }),
      appleKey.privateKey,
    );
    await service.appleLogin({
      identityToken: noEmail,
      email: victim.email,
    } as any);
    const where = prisma.user.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain(victim.email);
    expect(prisma.user.create.mock.calls[0][0].data.email).toContain(
      '@privaterelay.appleid.com',
    );
  });

  it('email Apple chưa xác minh không được dùng để liên kết tài khoản', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'new', ...data }),
    );
    const unverified = sign(
      claims({ email_verified: 'false' }),
      appleKey.privateKey,
    );
    await service.appleLogin({ identityToken: unverified } as any);
    const where = prisma.user.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain(victim.email);
  });

  it('từ chối token không có exp', async () => {
    const noExp = sign(claims({ exp: undefined }), appleKey.privateKey);
    await expect(
      service.appleLogin({ identityToken: noExp } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('resetPassword', () => {
    let cache: Map<string, unknown>;
    beforeEach(() => {
      cache = new Map();
      (service as any).cacheManager = {
        get: async (k: string) => cache.get(k),
        set: async (k: string, v: unknown) => void cache.set(k, v),
        del: async (k: string) => void cache.delete(k),
      };
      prisma.user.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'u1', username: 'minh' });
      prisma.user.update = jest.fn().mockResolvedValue({});
    });

    it('đặt mật khẩu mới khi OTP đúng, và mã không dùng lại được', async () => {
      cache.set('phone_otp:a@b.com', '123456');
      const res = await service.resetPassword('a@b.com', '123456', 'matkhau-moi');
      expect(res).toEqual({ success: true, username: 'minh' });
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      await expect(
        service.resetPassword('a@b.com', '123456', 'matkhau-khac'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('không đổi mật khẩu khi OTP sai', async () => {
      cache.set('phone_otp:a@b.com', '123456');
      await expect(
        service.resetPassword('a@b.com', '000000', 'matkhau-moi'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('chấp nhận token có chữ ký Apple hợp lệ', async () => {
    const valid = sign(claims(), appleKey.privateKey);
    const res = await service.appleLogin({ identityToken: valid } as any);
    expect(res.token).toBe('jwt');
    expect(res.user.email).toBe(victim.email);
  });
});

describe('normalizeIdentifier', () => {
  it('email về chữ thường để không thành 2 tài khoản/2 khoá OTP', () => {
    expect(normalizeIdentifier('  An@Gmail.COM ')).toBe('an@gmail.com');
  });
  it('SĐT giữ nguyên (chỉ trim)', () => {
    expect(normalizeIdentifier(' +84901234567 ')).toBe('+84901234567');
  });
});
