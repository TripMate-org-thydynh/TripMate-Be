import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { ItinerariesController } from './itineraries.controller';
import { ItinerariesService } from './itineraries.service';

@Module({
  imports: [ActivitiesModule],
  controllers: [ItinerariesController],
  providers: [ItinerariesService],
})
export class ItinerariesModule {}
