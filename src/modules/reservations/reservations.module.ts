import { Module } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { UpcomingReservationsController } from './upcoming-reservations.controller';
import { ReservationsService } from './reservations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [ReservationsController, UpcomingReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
