import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckinsService } from './checkins.service';
import { UpsertCheckinDto } from './dto/upsert-checkin.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Checkins')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/checkins')
export class CheckinsController {
  constructor(private readonly checkinsService: CheckinsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách điểm danh' })
  getAll(@Param('tripId') tripId: string) {
    return this.checkinsService.getAll(tripId);
  }

  @Put()
  @ApiOperation({ summary: 'Điểm danh / cập nhật trạng thái ngày đi' })
  upsert(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: UpsertCheckinDto,
  ) {
    return this.checkinsService.upsert(tripId, user.id, dto);
  }
}
