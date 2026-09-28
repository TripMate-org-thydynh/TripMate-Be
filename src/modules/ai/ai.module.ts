import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { GeocodingService } from '../itineraries/geocoding.service';
import { AiCacheService } from './ai-cache.service';
import { AiEmbeddingService } from './ai-embedding.service';
import { AiCorrectionsService } from './ai-corrections.service';
import { AiQueryRewriterService } from './ai-query-rewriter.service';
import { WebResearchService } from './web-research.service';

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
    // Tìm kiếm theo nghĩa (pgvector) trên kho mẫu cộng đồng.
    AiEmbeddingService,
    // Tìm kiếm + crawl web để AI trả lời địa điểm bằng thông tin thật.
    WebResearchService,
  ],
  exports: [AiService, AiCacheService, AiCorrectionsService, AiEmbeddingService],
})
export class AiModule {}
