import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { VacayService } from './vacay.service';
import { CreateVacationDayDto } from './dto/create-vacation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Vacay')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('vacay')
export class VacayController {
  constructor(private readonly vacayService: VacayService) {}

  @Get('holidays')
  @ApiOperation({ summary: 'Danh sách ngày lễ Việt Nam 2026-2027' })
  getHolidays() {
    return this.vacayService.getHolidays();
  }

  @Get('my-days')
  @ApiOperation({ summary: 'Ngày nghỉ của tôi' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  getMyDays(@CurrentUser() user: User, @Query('year') year?: string) {
    return this.vacayService.getMyDays(user.id, year ? parseInt(year) : undefined);
  }

  @Post('my-days')
  @ApiOperation({ summary: 'Thêm / cập nhật ngày nghỉ' })
  addDay(@CurrentUser() user: User, @Body() dto: CreateVacationDayDto) {
    return this.vacayService.addDay(user.id, dto);
  }

  @Delete('my-days/:date')
  @ApiOperation({ summary: 'Xóa ngày nghỉ (date: YYYY-MM-DD)' })
  deleteDay(@CurrentUser() user: User, @Param('date') date: string) {
    return this.vacayService.deleteDay(user.id, date);
  }

  @Get('bridge-suggestions')
  @ApiOperation({ summary: 'Gợi ý cầu ngày lễ' })
  getBridgeSuggestions() {
    return this.vacayService.getBridgeSuggestions();
  }
}
