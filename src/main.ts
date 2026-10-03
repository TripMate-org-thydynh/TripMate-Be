import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { PrismaClientExceptionFilter } from './common/filters/prisma-exception.filter';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { I18nValidationPipe, I18nValidationExceptionFilter } from 'nestjs-i18n';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MetricsBufferService } from './modules/observability/metrics-buffer.service';
import { makeMetricsMiddleware } from './modules/observability/metrics.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const isProd = process.env.NODE_ENV === 'production';

  // Sau reverse proxy (Render) `req.ip` mặc định là IP của proxy, nên rate
  // limit theo IP dồn MỌI người dùng vào một xô: 100 req/phút cho cả hệ thống
  // và một client đủ làm tất cả ăn 429. Tin đúng số hop proxy phía trước để
  // `req.ip` là IP thật. Đặt TRUST_PROXY_HOPS nếu hạ tầng có nhiều lớp hơn;
  // đừng đặt lớn hơn thực tế — client sẽ giả được X-Forwarded-For.
  const trustProxyHops = Number(
    process.env.TRUST_PROXY_HOPS ?? (isProd ? 1 : 0),
  );
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  // Body mặc định 1MB. Chỉ các route nhận ảnh base64 mới được 25MB — nếu để
  // 25MB toàn cục thì cả route chưa đăng nhập cũng buộc server đọc và parse
  // 25MB JSON cho mỗi request.
  const LARGE_BODY_ROUTE =
    /^\/api\/v1\/(ai\/photo-location|trips\/[^/]+\/reservations\/import(-image)?|trips\/[^/]+\/expenses\/ocr)\/?$/;
  const largeJson = json({ limit: '25mb' });
  const smallJson = json({ limit: '1mb' });
  app.use((req: Request, res: Response, next: NextFunction) =>
    (LARGE_BODY_ROUTE.test(req.path) ? largeJson : smallJson)(req, res, next),
  );
  app.use(urlencoded({ limit: '1mb', extended: true }));

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Metrics middleware đo lường latency và HTTP status code
  // Đặt sớm trước helmet, CORS, pipes, filters để bắt được cả request bị chặn (401/403/429) và 404
  const metricsBuffer = app.get(MetricsBufferService);
  app.use(makeMetricsMiddleware(metricsBuffer));

  // Security headers. Tắt CSP ở dev để Swagger UI hoạt động.
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:5173'];

  app.enableCors({
    origin: isProd ? allowedOrigins : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new I18nValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global Interceptors
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new TransformInterceptor(app.get(Reflector)),
  );

  // Global Exception Filters
  app.useGlobalFilters(
    new PrismaClientExceptionFilter(),
    new HttpExceptionFilter(),
    new I18nValidationExceptionFilter(),
  );

  // Swagger OpenAPI only in development
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('TripMate API')
      .setDescription(
        '🌏 TripMate - Super App Du Lịch Nhóm Gen Z | Plan chill. Chia tiền ez. Lưu moment.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'JWT',
      )
      .addTag('Auth', 'Đăng ký & đăng nhập')
      .addTag('Users', 'Quản lý hồ sơ người dùng')
      .addTag('Trips', 'Tạo và quản lý chuyến đi')
      .addTag('Itineraries', 'Lịch trình chi tiết')
      .addTag('Expenses', 'Theo dõi chi tiêu nhóm')
      .addTag('Moments', 'Ảnh & kỷ niệm chuyến đi')
      .addTag('Chat', 'Trò chuyện nhóm realtime')
      .addTag('Polls', 'Bình chọn & quyết định nhóm')
      .addTag('Games', 'Mini games vui vẻ')
      .addTag('Notifications', 'Thông báo')
      .addTag('AI', 'Trợ lý AI thông minh')
      .addTag('Activities', 'Nhật ký hoạt động chuyến đi')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 TripMate API running on: http://localhost:${port}/api/v1`);
  console.log(`📖 Swagger docs: http://localhost:${port}/docs`);
}

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('beforeExit', (code) => {
  console.log(`[PROCESS BEFORE EXIT] code=${code}`);
});

process.on('exit', (code) => {
  console.log(`[PROCESS EXIT] code=${code}`);
});

process.on('SIGINT', () => {
  console.log('[PROCESS SIGNAL] SIGINT received');
});

process.on('SIGTERM', () => {
  console.log('[PROCESS SIGNAL] SIGTERM received');
});

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
});
