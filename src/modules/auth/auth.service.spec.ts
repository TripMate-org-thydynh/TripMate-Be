import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { TwilioService } from './twilio.service';
import { MailService } from './mail.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: TwilioService, useValue: { sendSms: jest.fn() } },
        { provide: MailService, useValue: { sendEmail: jest.fn() } },
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
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
});
