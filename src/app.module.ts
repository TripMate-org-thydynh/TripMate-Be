import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore, redisInsStore } from 'cache-manager-redis-yet';
import { createClient } from 'redis';
import {
  appConfig,
  dbConfig,
  authConfig,
  redisConfig,
  twilioConfig,
  aiConfig,
} from './common/config/app.config';
import { envValidationSchema } from './common/config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { XpModule } from './modules/xp/xp.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TripsModule } from './modules/trips/trips.module';
import { ItinerariesModule } from './modules/itineraries/itineraries.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { MomentsModule } from './modules/moments/moments.module';
import { GamesModule } from './modules/games/games.module';
import { ChatModule } from './modules/chat/chat.module';
import { PollsModule } from './modules/polls/polls.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AiModule } from './modules/ai/ai.module';
import { ActivitiesModule } from './modules/activities/activities.module';
import { PremiumModule } from './modules/premium/premium.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { FundModule } from './modules/fund/fund.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { PackingModule } from './modules/packing/packing.module';
import { BucketModule } from './modules/bucket/bucket.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { TodosModule } from './modules/todos/todos.module';
import { InvitesModule } from './modules/invites/invites.module';
import { NotesModule } from './modules/notes/notes.module';
import { CheckinsModule } from './modules/checkins/checkins.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { JournalModule } from './modules/journal/journal.module';
import { VacayModule } from './modules/vacay/vacay.module';
import { AdminModule } from './modules/admin/admin.module';
import {
  I18nModule,
  AcceptLanguageResolver,
  QueryResolver,
  HeaderResolver,
} from 'nestjs-i18n';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import * as path from 'path';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      load: [
        appConfig,
        dbConfig,
        authConfig,
        redisConfig,
        twilioConfig,
        aiConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const client = createClient({
          url: config.get<string>('redis.url'),
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 1) {
                return new Error('Redis connection failed');
              }
              return 1000;
            },
            connectTimeout: 4000,
          },
        });
        client.on('error', (err) => {
          console.error('Redis Cache Client socket error:', err);
        });
        try {
          await client.connect();
        } catch (err) {
          console.error(
            'Failed to connect to Redis cache during startup:',
            err.message || err,
          );
        }
        return {
          store: redisInsStore(client as any),
          ttl: 300000,
        };
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    I18nModule.forRoot({
      fallbackLanguage: 'vi',
      loaderOptions: {
        // `i18n/` luôn nằm cạnh thư mục gốc code đang chạy: `src/i18n` khi dev,
        // `dist/i18n` sau khi build (nest-cli copy theo assets config). Dùng
        // thẳng __dirname thay vì đoán theo chuỗi 'dist' — heuristic cũ hỏng
        // ngay khi output đổi từ dist/src/ sang dist/, làm app crash lúc khởi
        // động ở production.
        path: path.join(__dirname, 'i18n'),
        // Watcher chỉ có ích lúc dev; ở prod nó giữ file handle vô ích.
        watch: process.env.NODE_ENV !== 'production',
      },
      resolvers: [
        new QueryResolver(['lang', 'l']),
        new HeaderResolver(['x-custom-lang', 'accept-language']),
        AcceptLanguageResolver,
      ],
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    TripsModule,
    ItinerariesModule,
    ExpensesModule,
    MomentsModule,
    XpModule,
    GamesModule,
    ChatModule,
    PollsModule,
    NotificationsModule,
    AiModule,
    ActivitiesModule,
    PremiumModule,
    DashboardModule,
    HealthModule,
    FundModule,
    WishlistModule,
    PackingModule,
    BucketModule,
    ReservationsModule,
    TodosModule,
    InvitesModule,
    NotesModule,
    CheckinsModule,
    DocumentsModule,
    JournalModule,
    VacayModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
