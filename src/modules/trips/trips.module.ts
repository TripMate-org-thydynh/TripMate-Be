import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { PremiumModule } from '../premium/premium.module';

@Module({
  // Cần EntitlementService để chặn khi vượt hạn mức của bản Free.
  imports: [PremiumModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
