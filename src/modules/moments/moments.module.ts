import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { MomentsController } from './moments.controller';
import { MomentsService } from './moments.service';
import { PremiumModule } from '../premium/premium.module';

@Module({
  imports: [ActivitiesModule, PremiumModule],
  controllers: [MomentsController],
  providers: [MomentsService],
})
export class MomentsModule {}
