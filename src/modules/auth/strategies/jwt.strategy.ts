import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  /// Chỉ có ở token chuyên dụng (vd. vé đăng ký) — không phải access token.
  purpose?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  async validate(payload: JwtPayload) {
    // Cùng một JWT_SECRET ký cả vé đăng ký; chỉ token đăng nhập (có `sub`,
    // không có `purpose`) mới được coi là phiên hợp lệ.
    if (payload.purpose || typeof payload.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException('Invalid token');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.isLocked) {
      throw new UnauthorizedException('errors.auth.user_locked');
    }
    return user;
  }
}
