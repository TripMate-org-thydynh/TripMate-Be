import type { User } from '@prisma/client';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
@ApiTags('Notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Post('devices')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ghi token FCM của máy để nhận thông báo đẩy' })
  async registerDevice(
    @CurrentUser() user: User,
    @Body() dto: RegisterDeviceDto,
  ) {
    await this.push.registerToken(user.id, dto.token, dto.platform);
  }

  @Delete('devices/:token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Gỡ token khi đăng xuất' })
  async removeDevice(@CurrentUser() user: User, @Param('token') token: string) {
    await this.push.removeToken(user.id, token);
  }

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách thông báo' })
  findAll(@CurrentUser() user: User) {
    return this.notificationsService.findAll(user.id);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Số thông báo chưa đọc' })
  unreadCount(@CurrentUser() user: User) {
    return this.notificationsService.getUnreadCount(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Đánh dấu đã đọc' })
  markRead(@Param('id') id: string, @CurrentUser() user: User) {
    return this.notificationsService.markRead(id, user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Đánh dấu tất cả đã đọc' })
  markAllRead(@CurrentUser() user: User) {
    return this.notificationsService.markAllRead(user.id);
  }
}
