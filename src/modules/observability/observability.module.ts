import { ClientErrorsController } from './client-errors.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MetricsBufferService } from './metrics-buffer.service';
import { ObservabilityService } from './observability.service';
import { ObservabilityController } from './observability.controller';
import { RequestFailuresService } from './request-failures.service';

@Module({
  imports: [PrismaModule],
  controllers: [ObservabilityController, ClientErrorsController],
  providers: [
    MetricsBufferService,
    ObservabilityService,
    RequestFailuresService,
  ],
  exports: [MetricsBufferService, ObservabilityService, RequestFailuresService],
})
export class ObservabilityModule {}
