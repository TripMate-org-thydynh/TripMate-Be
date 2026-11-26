import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AppConfigController } from './app-config.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAppPolicyController } from './admin-app-policy.controller';
import { AppPolicyService } from './app-policy.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    HealthController,
    AppConfigController,
    AdminAppPolicyController,
  ],
  providers: [AppPolicyService],
})
export class HealthModule {}
