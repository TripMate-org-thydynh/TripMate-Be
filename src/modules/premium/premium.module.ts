import { Module } from '@nestjs/common';
import { PremiumController } from './premium.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PremiumService } from './premium.service';
import { EntitlementService } from './entitlement.service';
import { PaymentGatewayService } from './payment-gateway.service';
import { TrialService } from './trial.service';
import { TrialEligibilityService } from './trial-eligibility.service';
import { TrialExpiryJob } from './trial-expiry.job';
import { PromoService } from './promo.service';
import { ReferralService } from './referral.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  // XpService (để trao XP khi giới thiệu thành công) đến từ XpModule, vốn đã
  // là @Global nên không cần import lại ở đây.
  imports: [PrismaModule],
  controllers: [PremiumController, PaymentWebhookController],
  providers: [
    PremiumService,
    EntitlementService,
    PaymentGatewayService,
    TrialService,
    TrialEligibilityService,
    TrialExpiryJob,
    PromoService,
    ReferralService,
  ],
  // Xuất ra để mọi module khác hỏi được "người này được dùng gì".
  exports: [PremiumService, EntitlementService, TrialService],
})
export class PremiumModule {}
