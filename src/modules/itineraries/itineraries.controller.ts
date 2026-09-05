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
import type { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ItinerariesService } from './itineraries.service';
import { CreateItineraryItemDto } from './dto/create-itinerary-item.dto';
import { UpdateItineraryItemDto } from './dto/update-itinerary-item.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';

@ApiTags('Itineraries')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/itinerary')
export class ItinerariesController {
  constructor(private readonly itinerariesService: ItinerariesService) {}

  @Post()
  @ApiOperation({ summary: 'Thêm điểm dừng vào lịch trình' })
  create(
    @Param('tripId') tripId: string,
    @Body() dto: CreateItineraryItemDto,
    @CurrentUser() user: User,
  ) {
    return this.itinerariesService.create(tripId, dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Lấy toàn bộ lịch trình theo ngày' })
  findAll(@Param('tripId') tripId: string) {
    return this.itinerariesService.findAll(tripId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiết điểm dừng' })
  findOne(@Param('tripId') tripId: string, @Param('id') id: string) {
    return this.itinerariesService.findOne(id, tripId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật điểm dừng' })
  update(
    @Param('tripId') tripId: string,
    @Param('id') id: string,
    @Body() dto: UpdateItineraryItemDto,
  ) {
    return this.itinerariesService.update(id, tripId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa điểm dừng' })
  remove(@Param('tripId') tripId: string, @Param('id') id: string) {
    return this.itinerariesService.remove(id, tripId);
  }
}
