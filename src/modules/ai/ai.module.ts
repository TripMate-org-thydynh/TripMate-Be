import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeocodingService } from '../itineraries/geocoding.service';
import { AiCacheService } from './ai-cache.service';
import { AiCorrectionsService } from './ai-corrections.service';
import { AiQueryRewriterService } from './ai-query-rewriter.service';

@Module({
  // PremiumModule cho EntitlementService: chặn khi vượt hạn mức AI/tháng.
  imports: [PremiumModule],
  controllers: [AiController],
  providers: [
    AiService,
    // GeocodingService: tra tên phương án AI đoán ra toạ độ thật
    // (photo-location).
    GeocodingService,
    // Ba lớp bọc quanh lời gọi Gemini: đệm câu trả lời lặp, đính chính tri
    // thức đã duyệt, và viết lại câu hỏi nối tiếp thành câu độc lập.
    AiCacheService,
    AiCorrectionsService,
    AiQueryRewriterService,
  ],
  exports: [AiService, AiCacheService, AiCorrectionsService],
})
export class AiModule {}
