import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MetricsBufferService } from './metrics-buffer.service';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ObservabilityController],
  providers: [MetricsBufferService, ObservabilityService],
  exports: [MetricsBufferService, ObservabilityService],
})
export class ObservabilityModule {}

