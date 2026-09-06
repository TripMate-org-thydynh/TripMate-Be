import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  // PremiumModule cho EntitlementService: chặn khi vượt hạn mức AI/tháng.
  imports: [PremiumModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
