import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AppConfigController } from './app-config.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController, AppConfigController],
})
export class HealthModule {}
