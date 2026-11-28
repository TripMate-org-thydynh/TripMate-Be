import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller';
import { AppConfigController } from './app-config.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAppPolicyController } from './admin-app-policy.controller';
import { AppPolicyService } from './app-policy.service';
import { CapabilitiesService } from './capabilities.service';
import { CapabilityGuard } from './capability.guard';
import { AdminCapabilitiesController } from './admin-capabilities.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    HealthController,
    AppConfigController,
    AdminAppPolicyController,
    AdminCapabilitiesController,
  ],
  providers: [AppPolicyService, CapabilitiesService, { provide: APP_GUARD, useClass: CapabilityGuard }],
})
export class HealthModule {}
