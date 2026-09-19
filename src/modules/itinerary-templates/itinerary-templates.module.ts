import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import {
  ItineraryTemplatesController,
  TripTemplatePublishController,
} from './itinerary-templates.controller';
import { ItineraryTemplatesService } from './itinerary-templates.service';

@Module({
  imports: [TripsModule],
  controllers: [ItineraryTemplatesController, TripTemplatePublishController],
  providers: [ItineraryTemplatesService],
})
export class ItineraryTemplatesModule {}
