import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { UserRole, Plan } from '@prisma/client';
import {
  IsEnum,
  IsBoolean,
  IsOptional,
  IsString,
  IsNumber,
  IsDateString,
  Min,
  IsNotEmpty,
} from 'class-validator';

// --- INLINED DTOS ---
class ExtendSubscriptionDto {
  @IsNumber()
  @Min(1)
  months: number;

  @IsString()
  @IsNotEmpty({ message: 'Lý do gia hạn không được để trống' })
  reason: string;
}

class RevokeSubscriptionDto {
  @IsString()
  @IsNotEmpty({ message: 'Lý do thu hồi không được để trống' })
  reason: string;
}

class UpdateUserDto {
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsBoolean()
  @IsOptional()
  isLocked?: boolean;
}

class UpdateConfigDto {
  @IsString()
  value: string;

  @IsString()
  @IsOptional()
  description?: string;
}

class CreateTripDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  destination?: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsString()
  createdBy: string;
}

class CreateReservationDto {
  @IsString()
  tripId: string;

  @IsString()
  addedBy: string;

  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  confirmationNumber?: string;

  @IsNumber()
  @IsOptional()
  price?: number;
}

class CreateJournalDto {
  @IsString()
  tripId: string;

  @IsString()
  authorId: string;

  @IsString()
  body: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  mood?: string;

  @IsDateString()
  entryDate: string;
}

class CreatePackingDto {
  @IsString()
  tripId: string;

  @IsString()
  addedBy: string;

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsNumber()
  @IsOptional()
  quantity?: number;
}

@ApiTags('Admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth('JWT')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Lấy thống kê hệ thống (admin)' })
  getStats() {
    return this.adminService.getStats();
  }

  @Get('analytics/growth')
  @ApiOperation({ summary: 'Thống kê tăng trưởng (admin)' })
  getGrowthAnalytics() {
    return this.adminService.getGrowthAnalytics();
  }

  @Get('analytics/revenue')
  @ApiOperation({ summary: 'Thống kê doanh thu & giao dịch (admin)' })
  getRevenueAnalytics() {
    return this.adminService.getRevenueAnalytics();
  }

  @Get('analytics/ai')
  @ApiOperation({ summary: 'Thống kê sử dụng AI (admin)' })
  getAiAnalytics() {
    return this.adminService.getAiAnalytics();
  }

  // --- USER ENDPOINTS ---
  @Get('users')
  @ApiOperation({ summary: 'Danh sách và tìm kiếm user (admin)' })
  getUsers(
    @Query('search') search?: string,
    @Query('role') role?: UserRole,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getUsers(search, role, page, limit);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Chi tiết 1 user (admin)' })
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Cập nhật role, trạng thái khoá/mở user (admin)' })
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Xoá mềm user (admin)' })
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  // --- TRIP ENDPOINTS ---
  @Get('trips')
  @ApiOperation({ summary: 'Xem danh sách chuyến đi (admin)' })
  getTrips(
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getTrips(search, page, limit);
  }

  @Post('trips')
  @ApiOperation({ summary: 'Tạo mới chuyến đi (admin)' })
  createTrip(@Body() dto: CreateTripDto) {
    return this.adminService.createTrip({
      ...dto,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
    });
  }

  @Put('trips/:id')
  @ApiOperation({ summary: 'Cập nhật chuyến đi (admin)' })
  updateTrip(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateTrip(id, dto);
  }

  @Delete('trips/:id')
  @ApiOperation({ summary: 'Xoá chuyến đi (admin)' })
  deleteTrip(@Param('id') id: string) {
    return this.adminService.deleteTrip(id);
  }

  // --- RESERVATION ENDPOINTS ---
  @Get('reservations')
  @ApiOperation({ summary: 'Danh sách đặt chỗ (admin)' })
  getReservations(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getReservations(page, limit);
  }

  @Post('reservations')
  @ApiOperation({ summary: 'Tạo đặt chỗ (admin)' })
  createReservation(@Body() dto: CreateReservationDto) {
    return this.adminService.createReservation(dto);
  }

  @Put('reservations/:id')
  @ApiOperation({ summary: 'Cập nhật đặt chỗ (admin)' })
  updateReservation(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateReservation(id, dto);
  }

  @Delete('reservations/:id')
  @ApiOperation({ summary: 'Xoá đặt chỗ (admin)' })
  deleteReservation(@Param('id') id: string) {
    return this.adminService.deleteReservation(id);
  }

  // --- JOURNAL ENDPOINTS ---
  @Get('journals')
  @ApiOperation({ summary: 'Danh sách nhật ký (admin)' })
  getJournals(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.adminService.getJournals(page, limit);
  }

  @Post('journals')
  @ApiOperation({ summary: 'Tạo nhật ký (admin)' })
  createJournal(@Body() dto: CreateJournalDto) {
    return this.adminService.createJournal({
      ...dto,
      entryDate: new Date(dto.entryDate),
    });
  }

  @Put('journals/:id')
  @ApiOperation({ summary: 'Cập nhật nhật ký (admin)' })
  updateJournal(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updateJournal(id, dto);
  }

  @Delete('journals/:id')
  @ApiOperation({ summary: 'Xoá nhật ký (admin)' })
  deleteJournal(@Param('id') id: string) {
    return this.adminService.deleteJournal(id);
  }

  // --- PACKING ITEM ENDPOINTS ---
  @Get('packing-items')
  @ApiOperation({ summary: 'Danh sách đồ đạc chuẩn bị (admin)' })
  getPackingItems(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getPackingItems(page, limit);
  }

  @Post('packing-items')
  @ApiOperation({ summary: 'Tạo đồ chuẩn bị (admin)' })
  createPackingItem(@Body() dto: CreatePackingDto) {
    return this.adminService.createPackingItem(dto);
  }

  @Put('packing-items/:id')
  @ApiOperation({ summary: 'Cập nhật đồ chuẩn bị (admin)' })
  updatePackingItem(@Param('id') id: string, @Body() dto: any) {
    return this.adminService.updatePackingItem(id, dto);
  }

  @Delete('packing-items/:id')
  @ApiOperation({ summary: 'Xoá đồ chuẩn bị (admin)' })
  deletePackingItem(@Param('id') id: string) {
    return this.adminService.deletePackingItem(id);
  }

  // --- CONFIG ENDPOINTS ---
  @Get('configs')
  @ApiOperation({ summary: 'Lấy cấu hình hệ thống (admin)' })
  getConfigs() {
    return this.adminService.getConfigs();
  }

  @Put('configs/:key')
  @ApiOperation({ summary: 'Cập nhật cấu hình hệ thống (admin)' })
  updateConfig(@Param('key') key: string, @Body() dto: UpdateConfigDto) {
    return this.adminService.updateConfig(key, dto.value, dto.description);
  }

  @Delete('configs/:key')
  @ApiOperation({ summary: 'Xoá cấu hình hệ thống (admin)' })
  deleteConfig(@Param('key') key: string) {
    return this.adminService.deleteConfig(key);
  }

  // --- SUBSCRIPTION ENDPOINTS ---
  @Get('subscriptions')
  @ApiOperation({ summary: 'Xem danh sách gói đăng ký (admin)' })
  getSubscriptions(
    @Query('search') search?: string,
    @Query('plan') plan?: Plan,
    @Query('status') status?: string,
    @Query('expiringSoon') expiringSoon?: boolean | string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getSubscriptions({
      search,
      plan,
      status,
      expiringSoon,
      page,
      limit,
    });
  }

  @Get('subscriptions/:id')
  @ApiOperation({ summary: 'Xem chi tiết gói đăng ký & danh sách ghế Squad (admin)' })
  getSubscription(@Param('id') id: string) {
    return this.adminService.getSubscription(id);
  }

  @Post('subscriptions/:id/extend')
  @ApiOperation({ summary: 'Gia hạn thủ công gói đăng ký có ghi log lý do (admin)' })
  extendSubscription(
    @Param('id') id: string,
    @CurrentUser() admin: User,
    @Body() dto: ExtendSubscriptionDto,
  ) {
    return this.adminService.extendSubscription(
      admin.id,
      id,
      dto.months,
      dto.reason,
    );
  }

  @Post('subscriptions/:id/revoke')
  @ApiOperation({ summary: 'Thu hồi gói đăng ký có ghi log lý do (admin)' })
  revokeSubscription(
    @Param('id') id: string,
    @CurrentUser() admin: User,
    @Body() dto: RevokeSubscriptionDto,
  ) {
    return this.adminService.revokeSubscription(admin.id, id, dto.reason);
  }
}
