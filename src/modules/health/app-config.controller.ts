import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Cấu hình app đọc lúc khởi động (công khai, không cần đăng nhập):
 * - `minVersion`: thấp hơn → app chặn bằng màn "Cần cập nhật" (bắt buộc).
 * - `latestVersion`: thấp hơn nhưng ≥ min → popup cập nhật bỏ qua được.
 * - `maintenance`: true → app hiện màn bảo trì thay vì gọi API.
 *
 * Toàn bộ điều khiển qua biến môi trường trên Render, không cần deploy code:
 * APP_MIN_VERSION, APP_LATEST_VERSION, APP_MAINTENANCE=true|false,
 * APP_MAINTENANCE_MESSAGE, APP_STORE_URL_IOS, APP_STORE_URL_ANDROID.
 */
@ApiTags('Health')
@Controller('app-config')
export class AppConfigController {
  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Phiên bản tối thiểu / bảo trì cho app mobile' })
  get() {
    const env = process.env;
    return {
      minVersion: env.APP_MIN_VERSION || '1.0.0',
      latestVersion: env.APP_LATEST_VERSION || env.APP_MIN_VERSION || '1.0.0',
      maintenance: env.APP_MAINTENANCE === 'true',
      maintenanceMessage: env.APP_MAINTENANCE_MESSAGE || null,
      storeUrl: {
        ios: env.APP_STORE_URL_IOS || null,
        android:
          env.APP_STORE_URL_ANDROID ||
          'https://play.google.com/store/apps/details?id=com.tripmate.app',
      },
    };
  }
}
