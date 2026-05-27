import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
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
import {
  I18nModule,
  AcceptLanguageResolver,
  QueryResolver,
  HeaderResolver,
} from 'nestjs-i18n';
import * as path from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'vi',
      loaderOptions: {
        path: path.join(__dirname, __dirname.includes('dist') ? '../i18n/' : '/i18n/'),
        watch: true,
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
    GamesModule,
    ChatModule,
    PollsModule,
    NotificationsModule,
    AiModule,
    ActivitiesModule,
    PremiumModule,
    DashboardModule,
  ],
})
export class AppModule {}
