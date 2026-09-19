import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeocodingService } from '../itineraries/geocoding.service';

@Module({
  // PremiumModule cho EntitlementService: chặn khi vượt hạn mức AI/tháng.
  imports: [PremiumModule],
  controllers: [AiController],
  // GeocodingService: tra tên phương án AI đoán ra toạ độ thật (photo-location).
  providers: [AiService, GeocodingService],
  exports: [AiService],
})
export class AiModule {}
