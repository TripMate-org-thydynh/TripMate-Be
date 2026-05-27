import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ActivitiesService } from './activities.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';

@ApiTags('Activities')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  @ApiOperation({ summary: 'Nhật ký hoạt động của chuyến đi' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findByTrip(@Param('tripId') tripId: string, @Query('limit') limit?: number) {
    return this.activitiesService.findByTrip(tripId, limit ? +limit : 50);
  }
}
