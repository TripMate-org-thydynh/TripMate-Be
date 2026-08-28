import { Module } from '@nestjs/common';
import { PremiumController } from './premium.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PremiumService } from './premium.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PremiumController, PaymentWebhookController],
  providers: [PremiumService],
  exports: [PremiumService],
})
export class PremiumModule {}
