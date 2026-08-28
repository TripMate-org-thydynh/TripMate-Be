import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { JoinTripDto } from './dto/join-trip.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { TripRoles } from '../../common/decorators/trip-member.decorator';

@ApiTags('Trips')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  @ApiOperation({ summary: 'Tạo chuyến đi mới' })
  create(@CurrentUser() user: User, @Body() dto: CreateTripDto) {
    return this.tripsService.create(user.id, dto);
  }

  @Post('join')
  @ApiOperation({ summary: 'Tham gia chuyến đi bằng invite code' })
  join(@CurrentUser() user: User, @Body() dto: JoinTripDto) {
    return this.tripsService.join(user.id, dto);
  }

  @Get(':tripId')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Xem chi tiết chuyến đi' })
  findOne(@Param('tripId') tripId: string) {
    return this.tripsService.findOne(tripId);
  }

  @Patch(':tripId')
  @UseGuards(TripMemberGuard)
  @TripRoles('CREATOR')
  @ApiOperation({ summary: 'Cập nhật chuyến đi (Creator only)' })
  update(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.update(tripId, user.id, dto);
  }

  @Delete(':tripId')
  @UseGuards(TripMemberGuard)
  @TripRoles('CREATOR')
  @ApiOperation({ summary: 'Xóa chuyến đi (Creator only)' })
  delete(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.tripsService.delete(tripId, user.id);
  }

  @Get(':tripId/recap')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Số liệu tổng kết chuyến (Trip Wrapped)' })
  getRecap(@Param('tripId') tripId: string) {
    return this.tripsService.getRecap(tripId);
  }

  @Get(':tripId/members')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Danh sách thành viên' })
  getMembers(@Param('tripId') tripId: string) {
    return this.tripsService.getMembers(tripId);
  }

  @Delete(':tripId/leave')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Rời khỏi chuyến đi' })
  leave(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.tripsService.leave(tripId, user.id);
  }

  @Delete(':tripId/members/:userId')
  @UseGuards(TripMemberGuard)
  @TripRoles('CREATOR')
  @ApiOperation({ summary: 'Xóa thành viên (Creator only)' })
  removeMember(
    @Param('tripId') tripId: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: User,
  ) {
    return this.tripsService.removeMember(tripId, requester.id, userId);
  }

  @Post(':tripId/regenerate-code')
  @UseGuards(TripMemberGuard)
  @TripRoles('CREATOR')
  @ApiOperation({ summary: 'Tạo lại invite code' })
  regenerateCode(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.tripsService.regenerateInviteCode(tripId, user.id);
  }
}
