import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Dashboard')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Lấy tóm tắt dashboard: chuyến đi hiện tại + squad online' })
  getSummary(@CurrentUser() user: any) {
    return this.dashboardService.getSummary(user.id);
  }

  @Get('squad-online')
  @ApiOperation({ summary: 'Danh sách bạn bè đang online trong chuyến đi' })
  getSquadOnline(@CurrentUser() user: any) {
    return this.dashboardService.getSquadOnline(user.id);
  }

  @Get('recent-activities')
  @ApiOperation({ summary: 'Hoạt động gần đây của squad' })
  getRecentActivities(@CurrentUser() user: any) {
    return this.dashboardService.getRecentActivities(user.id);
  }
}
