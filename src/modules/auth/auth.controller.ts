import type { User } from '@prisma/client';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { RegisterPasswordDto } from './dto/register-password.dto';
import { LoginPasswordDto } from './dto/login-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({
    summary: 'Hoàn tất đăng ký bằng vé từ verify-otp / google',
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @ApiOperation({ summary: 'Đăng nhập bằng Supabase ID - nhận JWT' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Throttle({ default: { limit: 3, ttl: 600000 } })
  @Post('send-otp')
  @ApiOperation({ summary: 'Gửi mã OTP đăng nhập qua SMS Twilio' })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phoneNumber);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify-otp')
  @ApiOperation({
    summary: 'Xác minh mã OTP đăng nhập SMS - nhận JWT hoặc supabaseId',
  })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phoneNumber, dto.code);
  }

  // Theo IP (chưa có token). 20/phút để cả nhóm chung Wi-Fi đăng ký cùng lúc được.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('register-password')
  @ApiOperation({
    summary: 'Đăng ký nhanh bằng username + mật khẩu (+ xác nhận) - nhận JWT',
  })
  registerPassword(@Body() dto: RegisterPasswordDto) {
    return this.authService.registerWithPassword(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login-password')
  @ApiOperation({ summary: 'Đăng nhập bằng username + mật khẩu - nhận JWT' })
  loginPassword(@Body() dto: LoginPasswordDto) {
    return this.authService.loginWithPassword(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('google')
  @ApiOperation({
    summary: 'Đăng nhập Google - nhận JWT hoặc thông tin đăng ký',
  })
  googleLogin(@Body() dto: GoogleLoginDto) {
    return this.authService.googleLogin(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Lấy thông tin user hiện tại từ JWT' })
  me(@CurrentUser() user: User) {
    return user;
  }
}
