import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { PrismaClientExceptionFilter } from './common/filters/prisma-exception.filter';
import { I18nValidationPipe, I18nValidationExceptionFilter } from 'nestjs-i18n';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // CORS
  const isProd = process.env.NODE_ENV === 'production';
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
    new TransformInterceptor(),
  );

  // Global Exception Filters
  app.useGlobalFilters(
    new PrismaClientExceptionFilter(),
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
bootstrap();
