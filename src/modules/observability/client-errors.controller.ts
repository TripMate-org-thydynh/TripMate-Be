import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ClientErrorDto {
  @IsString()
  @MaxLength(500)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stack?: string;

  @IsIn(['flutter', 'platform', 'zone'])
  source: 'flutter' | 'platform' | 'zone';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  platform?: string;
}

/**
 * Nhận lỗi chưa bắt được từ app (FlutterError / PlatformDispatcher / zone).
 *
 * App chưa có Crashlytics/Sentry, nên trước đây crash bản phát hành là vô
 * hình. Ghi ra log có cấu trúc (Render giữ log), không lưu DB: đây là tín
 * hiệu để biết có lỗi, chưa phải hệ thống phân tích crash đầy đủ.
 *
 * Không cần đăng nhập (crash có thể xảy ra trước khi đăng nhập) nên giới hạn
 * chặt theo IP và độ dài; không nhận user id hay dữ liệu cá nhân.
 */
@ApiTags('Observability')
@Controller('observability')
export class ClientErrorsController {
  private readonly logger = new Logger('ClientError');

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('client-errors')
  @HttpCode(204)
  @ApiOperation({ summary: 'App gửi lỗi chưa bắt được (không cần đăng nhập)' })
  report(@Body() dto: ClientErrorDto): void {
    this.logger.warn(
      JSON.stringify({
        kind: 'client_error',
        source: dto.source,
        platform: dto.platform,
        appVersion: dto.appVersion,
        message: dto.message,
        stack: dto.stack?.split('\n').slice(0, 15).join('\n'),
      }),
    );
  }
}
