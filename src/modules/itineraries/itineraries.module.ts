import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { ItinerariesController } from './itineraries.controller';
import { ItinerariesService } from './itineraries.service';
import { GeocodingService } from './geocoding.service';
import { ItineraryWeatherService } from './itinerary-weather.service';

@Module({
  imports: [ActivitiesModule],
  controllers: [ItinerariesController],
  providers: [ItinerariesService, GeocodingService, ItineraryWeatherService],
  exports: [ItineraryWeatherService, ItinerariesService],
})
export class ItinerariesModule {}
