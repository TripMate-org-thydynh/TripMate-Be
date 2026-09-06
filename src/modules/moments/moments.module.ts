import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { PremiumModule } from '../premium/premium.module';
import { MomentsController } from './moments.controller';
import { MomentsService } from './moments.service';

@Module({
  // PremiumModule cho EntitlementService: chặn khi chuyến vượt hạn mức moment.
  imports: [ActivitiesModule, PremiumModule],
  controllers: [MomentsController],
  providers: [MomentsService],
})
export class MomentsModule {}
