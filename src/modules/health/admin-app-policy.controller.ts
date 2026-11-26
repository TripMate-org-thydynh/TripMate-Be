import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AppPolicyService,
  POLICY_CHANNELS,
  SaveAppPolicyDto,
} from './app-policy.service';

class PolicyQuery {
  @IsIn(POLICY_CHANNELS)
  channel: SaveAppPolicyDto['channel'] = 'default';
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/app-policy')
export class AdminAppPolicyController {
  constructor(private readonly policy: AppPolicyService) {}

  @Get()
  get(@Query() query: PolicyQuery) {
    return this.policy.adminOverview(query.channel);
  }

  @Put()
  publish(@Body() dto: SaveAppPolicyDto, @CurrentUser() admin: User) {
    return this.policy.publish(dto, admin.id);
  }
}
