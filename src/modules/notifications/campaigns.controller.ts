import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CampaignsService } from './campaigns.service';
import { CampaignDraftDto, CampaignPublishDto } from './dto/campaign.dto';

class StopCampaignDto {
  @IsString() @Matches(/\S/) @MaxLength(240)
  reason!: string;
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CampaignDraftDto) {
    return this.campaigns.save(null, dto, user.id);
  }

  @Patch(':id')
  edit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User, @Body() dto: CampaignDraftDto) {
    return this.campaigns.save(id, dto, user.id);
  }

  @Post(':id/test')
  sendTest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.campaigns.sendTest(id, user.id);
  }

  @Post(':id/schedule')
  schedule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User, @Body() dto: CampaignPublishDto) {
    return this.campaigns.schedule(id, dto, user.id);
  }

  @Post(':id/stop')
  stop(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User, @Body() dto: StopCampaignDto) {
    return this.campaigns.stop(id, dto.reason.trim(), user.id);
  }
}

@UseGuards(JwtAuthGuard)
@Controller('notifications/events')
export class CampaignPopupController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post('claim')
  claim(@CurrentUser() user: User) {
    return this.campaigns.claimPopup(user.id);
  }
}
