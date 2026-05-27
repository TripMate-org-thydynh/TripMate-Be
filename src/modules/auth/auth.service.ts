import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TwilioService } from './twilio.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private twilioService: TwilioService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  ensureValidUuid(input: string): string {
    // Standard UUID Regex pattern
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(input)) {
      return input;
    }
    // Hash deterministically to a valid UUID format using MD5
    const hash = crypto.createHash('md5').update(input).digest('hex');
    return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(
      12,
      16,
    )}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
  }

  async register(dto: RegisterDto) {
    const validSupabaseId = this.ensureValidUuid(dto.supabaseId);
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { supabaseId: validSupabaseId }],
      },
    });
    if (existing) {
      throw new ConflictException(
        'User with this email or supabaseId already exists',
      );
    }

    if (dto.username) {
      const usernameExists = await this.prisma.user.findUnique({
        where: { username: dto.username },
      });
      if (usernameExists) throw new ConflictException('Username already taken');
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        username: dto.username,
        supabaseId: validSupabaseId,
        avatarUrl: dto.avatarUrl,
      },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatarUrl: true,
        travelScore: true,
        chaosScore: true,
        createdAt: true,
      },
    });

    const token = this.generateToken(user.id, user.email);
    return { user, token };
  }

  async login(dto: LoginDto) {
    const validSupabaseId = this.ensureValidUuid(dto.supabaseId);
    if (
      dto.accessToken === 'dummy-token' ||
      dto.accessToken === 'mock-token' ||
      !dto.accessToken
    ) {
      // Enforce token verification in production environment
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'Supabase access token is required and cannot be mocked in production',
        );
      }
    } else {
      const verifiedSupabaseId = await this.verifySupabaseToken(dto.accessToken);
      const validVerifiedId = this.ensureValidUuid(verifiedSupabaseId);
      if (validVerifiedId !== validSupabaseId) {
        throw new UnauthorizedException(
          'Supabase ID does not match the token owner',
        );
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { supabaseId: validSupabaseId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatarUrl: true,
        bio: true,
        vibeTags: true,
        theme: true,
        travelScore: true,
        chaosScore: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found. Please register first.');
    }

    const token = this.generateToken(user.id, user.email);
    return { user, token };
  }

  async sendOtp(phoneNumber: string) {
    const cleanedPhone = phoneNumber.trim();
    // Generate a random 4-digit code
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    // Cache the OTP code for 5 minutes
    const cacheKey = `phone_otp:${cleanedPhone}`;
    await this.cacheManager.set(cacheKey, code, 300000);

    this.logger.log(`Generated OTP code ${code} for phone ${cleanedPhone}`);

    // Send via Twilio SMS
    const message = `[TripMate] Ma OTP dang nhap cua ban la: ${code}. Ma nay co hieu luc trong 5 phut.`;
    await this.twilioService.sendSms(cleanedPhone, message);

    return { success: true, message: 'OTP code sent successfully' };
  }

  async verifyOtp(phoneNumber: string, code: string) {
    const cleanedPhone = phoneNumber.trim();
    const cacheKey = `phone_otp:${cleanedPhone}`;

    const cachedCode = await this.cacheManager.get<string>(cacheKey);

    // Allow backdoor OTP '1234' in non-production environments
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const isBackdoor = isDevelopment && code === '1234';

    if (!cachedCode && !isBackdoor) {
      throw new UnauthorizedException('Mã OTP đã hết hạn hoặc không tồn tại');
    }

    if (cachedCode !== code && !isBackdoor) {
      throw new UnauthorizedException('Mã OTP không chính xác');
    }

    // OTP verified successfully - evict cache key
    await this.cacheManager.del(cacheKey);

    // Formulate a client-friendly mock supabaseId matching what standard app flow expects
    const clientSupabaseId = `sb-phone-${cleanedPhone.replace(/\D/g, '')}`;
    const validSupabaseId = this.ensureValidUuid(clientSupabaseId);

    const user = await this.prisma.user.findUnique({
      where: { supabaseId: validSupabaseId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatarUrl: true,
        bio: true,
        vibeTags: true,
        theme: true,
        travelScore: true,
        chaosScore: true,
      },
    });

    if (user) {
      const token = this.generateToken(user.id, user.email);
      return { exists: true, token, user };
    } else {
      return {
        exists: false,
        supabaseId: clientSupabaseId,
        email: `${cleanedPhone.replace(/\D/g, '')}@tripmate.com`,
      };
    }
  }

  async googleLogin(dto: GoogleLoginDto) {
    // Google idToken mock logic or custom validation
    const clientSupabaseId = `sb-google-${dto.email.split('@')[0]}`;
    const validSupabaseId = this.ensureValidUuid(clientSupabaseId);

    const user = await this.prisma.user.findUnique({
      where: { supabaseId: validSupabaseId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatarUrl: true,
        bio: true,
        vibeTags: true,
        theme: true,
        travelScore: true,
        chaosScore: true,
      },
    });

    if (user) {
      const token = this.generateToken(user.id, user.email);
      return { exists: true, token, user };
    } else {
      return {
        exists: false,
        supabaseId: clientSupabaseId,
        email: dto.email,
        name: dto.name,
        avatarUrl: dto.avatarUrl,
      };
    }
  }

  private async verifySupabaseToken(accessToken: string): Promise<string> {
    try {
      const supabaseUrl =
        process.env.SUPABASE_URL || 'https://ecuubhklnjvsgfcmjbgi.supabase.co';
      const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(process.env.SUPABASE_ANON_KEY
            ? { apikey: process.env.SUPABASE_ANON_KEY }
            : {}),
        },
      });

      if (!response.ok) {
        throw new UnauthorizedException('Invalid Supabase access token');
      }

      const data = await response.json();
      if (!data || !data.id) {
        throw new UnauthorizedException('Invalid Supabase user payload');
      }

      return data.id;
    } catch (error) {
      throw new UnauthorizedException(
        `Supabase token verification failed: ${error.message}`,
      );
    }
  }

  private generateToken(userId: string, email: string) {
    return this.jwtService.sign({ sub: userId, email });
  }
}
