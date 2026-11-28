import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CAPABILITIES, CAPABILITY_MODES, CapabilitiesService, type Capability, type CapabilityMode,
} from './capabilities.service';

class PublishCapabilityDto {
  @IsIn(CAPABILITY_MODES)
  mode!: CapabilityMode;
  @IsInt() @Min(0)
  expectedVersion!: number;
  @IsString() @Matches(/\S/) @MaxLength(240)
  reason!: string;
  @IsOptional() @IsString() @MaxLength(240)
  message?: string;
  @IsOptional() @IsISO8601()
  expiresAt?: string;
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/capabilities')
export class AdminCapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  overview() {
    return this.capabilities.admin();
  }

  @Put(':key')
  publish(@Param('key') key: Capability, @Body() dto: PublishCapabilityDto, @CurrentUser() user: User) {
    if (!CAPABILITIES.includes(key)) throw new BadRequestException('UNKNOWN_CAPABILITY');
    if (dto.expiresAt && (!/(Z|[+-]\d\d:\d\d)$/.test(dto.expiresAt) || Date.parse(dto.expiresAt) <= Date.now())) {
      throw new BadRequestException('CAPABILITY_EXPIRY_MUST_BE_IN_FUTURE');
    }
    return this.capabilities.publish(key, {
      mode: dto.mode, message: dto.message?.trim() ?? '', expiresAt: dto.expiresAt ?? null,
    }, dto.expectedVersion, dto.reason.trim(), user.id);
  }
}
