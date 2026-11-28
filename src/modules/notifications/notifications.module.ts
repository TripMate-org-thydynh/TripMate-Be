import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { CampaignPopupController, CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  controllers: [NotificationsController, CampaignsController, CampaignPopupController],
  providers: [NotificationsService, PushService, CampaignsService],
  exports: [NotificationsService, PushService],
})
export class NotificationsModule {}
