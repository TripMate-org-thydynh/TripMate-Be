import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { TwilioService } from './twilio.service';
import { MailService } from './mail.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$hashedpassword'),
  compare: jest.fn(),
}));

import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let cacheManager: any;
  let twilioService: any;
  let mailService: any;

  const mockUser = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'testuser@tripmate.local',
    name: 'testuser',
    username: 'testuser',
    supabaseId: '22222222-2222-2222-2222-222222222222',
    passwordHash: '$2b$10$hashedpassword',
    avatarUrl: null,
    travelScore: 0,
    chaosScore: 0,
    role: 'USER',
    isLocked: false,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    twilioService = {
      sendSms: jest.fn().mockResolvedValue(true),
    };

    mailService = {
      sendEmail: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: TwilioService, useValue: twilioService },
        { provide: MailService, useValue: mailService },
        { provide: CACHE_MANAGER, useValue: cacheManager },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('ensureValidUuid', () => {
    it('should return valid UUID as-is', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      expect(service.ensureValidUuid(validUuid)).toBe(validUuid);
    });

    it('should convert non-UUID string into deterministic UUID format', () => {
      const result = service.ensureValidUuid('custom-string');
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('registerWithPassword', () => {
    it('should throw BadRequestException if passwords do not match', async () => {
      await expect(
        service.registerWithPassword({
          username: 'testuser',
          password: 'password123',
          confirmPassword: 'differentpassword',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if username already exists', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);

      await expect(
        service.registerWithPassword({
          username: 'testuser',
          password: 'password123',
          confirmPassword: 'password123',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully register a new user and return user with token', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);

      const result = await service.registerWithPassword({
        username: 'newuser',
        password: 'password123',
        confirmPassword: 'password123',
      });

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('token', 'mock-jwt-token');
      expect(prisma.user.create).toHaveBeenCalled();
    });
  });

  describe('loginWithPassword', () => {
    it('should throw UnauthorizedException if user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.loginWithPassword({
          username: 'nonexistent',
          password: 'password123',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password comparison fails', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.loginWithPassword({
          username: 'testuser',
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should return user and token on valid credentials', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.loginWithPassword({
        username: 'testuser',
        password: 'password123',
      });

      expect(result).toHaveProperty('token', 'mock-jwt-token');
      expect(result.user.username).toBe('testuser');
    });
  });

  describe('sendOtp', () => {
    it('should generate 6-digit numeric OTP, cache it with 300000ms TTL, and reset attempts', async () => {
      const result = await service.sendOtp('+84912345678');

      expect(result).toEqual({
        success: true,
        message: 'OTP code sent successfully',
      });
      expect(cacheManager.set).toHaveBeenCalledWith(
        'phone_otp:+84912345678',
        expect.stringMatching(/^\d{6}$/),
        300000,
      );
      expect(cacheManager.del).toHaveBeenCalledWith(
        'phone_otp_attempts:+84912345678',
      );
      expect(twilioService.sendSms).toHaveBeenCalledWith(
        '+84912345678',
        expect.stringMatching(/\d{6}/),
      );
    });

    it('should send email if identifier contains @', async () => {
      const result = await service.sendOtp('user@example.com');

      expect(result.success).toBe(true);
      expect(mailService.sendEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.any(String),
        expect.stringMatching(/\d{6}/),
      );
    });
  });

  describe('verifyOtp', () => {
    it('should throw UnauthorizedException if OTP does not exist or expired', async () => {
      cacheManager.get.mockResolvedValue(null);

      await expect(
        service.verifyOtp('+84912345678', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should increment attempts on incorrect OTP and throw UnauthorizedException', async () => {
      cacheManager.get.mockImplementation(async (key: string) => {
        if (key === 'phone_otp:+84912345678') return '123456';
        if (key === 'phone_otp_attempts:+84912345678') return 0;
        return null;
      });

      await expect(
        service.verifyOtp('+84912345678', '654321'),
      ).rejects.toThrow(UnauthorizedException);

      expect(cacheManager.set).toHaveBeenCalledWith(
        'phone_otp_attempts:+84912345678',
        1,
        300000,
      );
    });

    it('should lock out and delete both cache keys when attempts reach 5', async () => {
      cacheManager.get.mockImplementation(async (key: string) => {
        if (key === 'phone_otp:+84912345678') return '123456';
        if (key === 'phone_otp_attempts:+84912345678') return 4;
        return null;
      });

      await expect(
        service.verifyOtp('+84912345678', '654321'),
      ).rejects.toThrow(UnauthorizedException);

      expect(cacheManager.del).toHaveBeenCalledWith('phone_otp:+84912345678');
      expect(cacheManager.del).toHaveBeenCalledWith(
        'phone_otp_attempts:+84912345678',
      );
    });

    it('should handle length mismatch safely without throwing RangeError and increment attempt', async () => {
      cacheManager.get.mockImplementation(async (key: string) => {
        if (key === 'phone_otp:+84912345678') return '123456';
        if (key === 'phone_otp_attempts:+84912345678') return 1;
        return null;
      });

      await expect(
        service.verifyOtp('+84912345678', '12'),
      ).rejects.toThrow(UnauthorizedException);

      expect(cacheManager.set).toHaveBeenCalledWith(
        'phone_otp_attempts:+84912345678',
        2,
        300000,
      );
    });

    it('should delete both cache keys and return user and token on valid OTP', async () => {
      cacheManager.get.mockImplementation(async (key: string) => {
        if (key === 'phone_otp:+84912345678') return '123456';
        return null;
      });
      prisma.user.findFirst.mockResolvedValue(mockUser);

      const result = await service.verifyOtp('+84912345678', '123456');

      expect(cacheManager.del).toHaveBeenCalledWith('phone_otp:+84912345678');
      expect(cacheManager.del).toHaveBeenCalledWith(
        'phone_otp_attempts:+84912345678',
      );
      expect(result).toHaveProperty('exists', true);
      expect(result).toHaveProperty('token', 'mock-jwt-token');
      expect(result).toHaveProperty('user');
    });
  });
});
