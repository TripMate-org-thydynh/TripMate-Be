import { Module } from '@nestjs/common';
import { PremiumController } from './premium.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PremiumService } from './premium.service';
import { EntitlementService } from './entitlement.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PremiumController, PaymentWebhookController],
  providers: [PremiumService, EntitlementService],
  // Xuất ra để mọi module khác hỏi được "người này được dùng gì".
  exports: [PremiumService, EntitlementService],
})
export class PremiumModule {}
