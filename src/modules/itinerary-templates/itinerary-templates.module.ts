import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { AiModule } from '../ai/ai.module';
import { ItinerariesModule } from '../itineraries/itineraries.module';
import {
  ItineraryTemplatesController,
  TripTemplatePublishController,
} from './itinerary-templates.controller';
import { ItineraryTemplatesService } from './itinerary-templates.service';
import { TemplateCatalogController, TemplateReviewController } from './template-catalog.controller';

@Module({
  imports: [TripsModule, AiModule, ItinerariesModule],
  controllers: [ItineraryTemplatesController, TripTemplatePublishController, TemplateCatalogController, TemplateReviewController],
  providers: [ItineraryTemplatesService],
})
export class ItineraryTemplatesModule {}
