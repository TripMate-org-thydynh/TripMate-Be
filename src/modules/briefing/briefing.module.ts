import {
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ItinerariesModule } from '../itineraries/itineraries.module';
import { BriefingService } from './briefing.service';

@ApiTags('Briefing')
@ApiBearerAuth('JWT')
@Controller()
export class BriefingController {
  constructor(private readonly briefing: BriefingService) {}

  @Get('trips/:tripId/brief/today')
  @UseGuards(JwtAuthGuard, TripMemberGuard)
  @ApiOperation({
    summary: 'Bản tin hôm nay của chuyến (thời tiết, điểm, việc)',
  })
  today(@Param('tripId') tripId: string, @Query('date') date?: string) {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date phải dạng YYYY-MM-DD');
    }
    return this.briefing.buildForTrip(tripId, date);
  }

  @Post('admin/briefing/send-now')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: 'Admin: gửi bản tin sáng ngay (không trùng)' })
  async sendNow() {
    return { sent: await this.briefing.sendAll() };
  }
}

@Module({
  imports: [ItinerariesModule],
  controllers: [BriefingController],
  providers: [BriefingService],
})
export class BriefingModule {}
