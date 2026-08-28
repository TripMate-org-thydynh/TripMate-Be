import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TwilioService } from './twilio.service';
import { MailService } from './mail.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { RegisterPasswordDto } from './dto/register-password.dto';
import { LoginPasswordDto } from './dto/login-password.dto';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
  );

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private twilioService: TwilioService,
    private mailService: MailService,
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
    if (!dto.accessToken) {
      throw new UnauthorizedException('Supabase access token is required');
    }

    const verifiedSupabaseId = await this.verifySupabaseToken(dto.accessToken);
    const validVerifiedId = this.ensureValidUuid(verifiedSupabaseId);
    if (validVerifiedId !== validSupabaseId) {
      throw new UnauthorizedException(
        'Supabase ID does not match the token owner',
      );
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

  /**
   * Đăng ký nhanh chỉ bằng username + mật khẩu. Các field bắt buộc khác
   * (email/name/supabaseId) được sinh tự động từ username.
   */
  async registerWithPassword(dto: RegisterPasswordDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    const username = dto.username.trim().toLowerCase();
    const usernameExists = await this.prisma.user.findUnique({
      where: { username },
    });
    if (usernameExists) {
      throw new ConflictException('Username đã tồn tại');
    }

    // Sinh các field bắt buộc từ username (không cần email thật khi đăng ký nhanh).
    const email = `${username}@tripmate.local`;
    const supabaseId = this.ensureValidUuid(`pwd-${username}`);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.username.trim(),
        username,
        supabaseId,
        passwordHash,
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

  /** Đăng nhập bằng username + mật khẩu. */
  async loginWithPassword(dto: LoginPasswordDto) {
    const username = dto.username.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { username },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Sai username hoặc mật khẩu');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Sai username hoặc mật khẩu');
    }

    const token = this.generateToken(user.id, user.email);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        vibeTags: user.vibeTags,
        theme: user.theme,
        travelScore: user.travelScore,
        chaosScore: user.chaosScore,
        role: user.role,
        isLocked: user.isLocked,
      },
      token,
    };
  }

  async sendOtp(phoneNumber: string) {
    const cleanedPhone = phoneNumber.trim();
    // Generate a random 4-digit code
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    // Cache the OTP code for 5 minutes
    const cacheKey = `phone_otp:${cleanedPhone}`;
    await this.cacheManager.set(cacheKey, code, 300000);

    this.logger.log(
      `Generated OTP code ${code} for phone/email ${cleanedPhone}`,
    );

    if (cleanedPhone.includes('@')) {
      // Gửi OTP qua email thật bằng SendGrid (fallback log nếu chưa cấu hình).
      const subject = '[TripMate] Mã OTP đăng nhập của bạn';
      const body = `Ma OTP dang nhap TripMate cua ban la: ${code}. Ma nay co hieu luc trong 5 phut.`;
      try {
        await this.mailService.sendEmail(cleanedPhone, subject, body);
      } catch (err) {
        this.logger.error(`SendGrid gửi email thất bại: ${err.message}`);
      }
    } else {
      // Send via Twilio SMS
      const message = `[TripMate] Ma OTP dang nhap cua ban la: ${code}. Ma nay co hieu luc trong 5 phut.`;
      try {
        await this.twilioService.sendSms(cleanedPhone, message);
      } catch (err) {
        this.logger.error(`Twilio send SMS failed: ${err.message}`);
      }
    }

    return { success: true, message: 'OTP code sent successfully' };
  }

  async verifyOtp(phoneNumber: string, code: string) {
    const cleanedPhone = phoneNumber.trim();
    const cacheKey = `phone_otp:${cleanedPhone}`;

    const cachedCode = await this.cacheManager.get<string>(cacheKey);

    if (!cachedCode) {
      throw new UnauthorizedException('Mã OTP đã hết hạn hoặc không tồn tại');
    }

    if (cachedCode !== code) {
      throw new UnauthorizedException('Mã OTP không chính xác');
    }

    // OTP verified successfully - evict cache key
    await this.cacheManager.del(cacheKey);

    // Formulate a client-friendly mock supabaseId
    const isEmail = cleanedPhone.includes('@');
    const clientSupabaseId = isEmail
      ? `sb-email-${cleanedPhone.replace(/[@.]/g, '-')}`
      : `sb-phone-${cleanedPhone.replace(/\D/g, '')}`;
    const validSupabaseId = this.ensureValidUuid(clientSupabaseId);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { supabaseId: validSupabaseId },
          ...(isEmail ? [{ email: cleanedPhone }] : []),
        ],
        deletedAt: null,
      },
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
        email: isEmail
          ? cleanedPhone
          : `${cleanedPhone.replace(/\D/g, '')}@tripmate.com`,
      };
    }
  }

  async googleLogin(dto: GoogleLoginDto) {
    let email = dto.email;
    let name = dto.name;
    let avatarUrl = dto.avatarUrl;

    // Cửa hậu dev (bỏ qua verify Google ID token) phải được BẬT TƯỜNG MINH.
    // Nếu chỉ dựa vào `NODE_ENV !== 'production'`, một deploy production quên
    // set NODE_ENV sẽ mở toang đường đăng nhập bằng 'mock-google-token'.
    const isDevelopment =
      process.env.NODE_ENV !== 'production' &&
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true';

    if (dto.idToken === 'mock-google-token' && isDevelopment) {
      this.logger.warn(
        `Bypassing Google ID token verification in development mode.`,
      );
    } else {
      try {
        const ticket = await this.googleClient.verifyIdToken({
          idToken: dto.idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload) {
          throw new UnauthorizedException('Invalid Google ID token payload');
        }

        if (!payload.email) {
          throw new UnauthorizedException(
            'Google ID token is missing email address',
          );
        }
        email = payload.email;
        name = payload.name || name;
        avatarUrl = payload.picture || avatarUrl;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (
          isDevelopment &&
          (errMsg.includes('Token used too late') ||
            errMsg.includes('clock skew') ||
            errMsg.includes('expired'))
        ) {
          this.logger.warn(
            `Google ID token verification failed/expired but accepted via fallback in development: ${errMsg}`,
          );
          const payload = this.decodeJwtPayload(dto.idToken);
          if (payload && payload.email) {
            email = payload.email;
            name = payload.name || name;
            avatarUrl = payload.picture || avatarUrl;
          } else {
            throw new UnauthorizedException(
              `Google login failed (and payload decoding failed): ${errMsg}`,
            );
          }
        } else {
          throw new UnauthorizedException(`Google login failed: ${errMsg}`);
        }
      }
    }

    const clientSupabaseId = `sb-google-${email.split('@')[0]}`;
    const validSupabaseId = this.ensureValidUuid(clientSupabaseId);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ supabaseId: validSupabaseId }, { email: email }],
        deletedAt: null,
      },
      select: {
        id: true,
        supabaseId: true,
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
      if (user.supabaseId !== validSupabaseId) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { supabaseId: validSupabaseId },
        });
      }
      const token = this.generateToken(user.id, user.email);
      return { exists: true, token, user };
    } else {
      return {
        exists: false,
        supabaseId: clientSupabaseId,
        email: email,
        name: name,
        avatarUrl: avatarUrl,
      };
    }
  }

  private async verifySupabaseToken(accessToken: string): Promise<string> {
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      if (!supabaseUrl) {
        throw new Error('SUPABASE_URL environment variable is not configured');
      }
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

      const data = (await response.json()) as { id?: string } | null;
      if (!data || !data.id) {
        throw new UnauthorizedException('Invalid Supabase user payload');
      }

      return data.id;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new UnauthorizedException(
        `Supabase token verification failed: ${errMsg}`,
      );
    }
  }

  private generateToken(userId: string, email: string) {
    return this.jwtService.sign({ sub: userId, email });
  }

  private decodeJwtPayload(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }
}
