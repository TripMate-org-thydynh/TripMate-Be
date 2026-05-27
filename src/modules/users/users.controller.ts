import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePresenceDto } from './dto/update-presence.dto';

@ApiTags('Users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Lấy profile hiện tại' })
  getMe(@CurrentUser() user: any) {
    return this.usersService.findById(user.id);
  }

  @Get('me/trips')
  @ApiOperation({ summary: 'Lấy danh sách chuyến đi của tôi' })
  getMyTrips(@CurrentUser() user: any) {
    return this.usersService.getMyTrips(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Cập nhật profile' })
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Post('me/presence')
  @ApiOperation({ summary: 'Cập nhật trạng thái online/vị trí của tôi' })
  updatePresence(@CurrentUser() user: any, @Body() dto: UpdatePresenceDto) {
    return this.usersService.updatePresence(user.id, dto);
  }

  // --- MODULE 9 PROFILE FLOW ENDPOINTS ---

  @Get('me/badges')
  @ApiOperation({ summary: 'Lấy danh hiệu / cúp phượt thủ' })
  getBadges(@CurrentUser() user: any) {
    return this.usersService.getBadges(user.id);
  }

  @Get('theme-marketplace')
  @ApiOperation({ summary: 'Xem chợ chủ đề hình nền app' })
  getThemes() {
    return this.usersService.getThemeMarketplace();
  }

  @Get('sticker-store')
  @ApiOperation({ summary: 'Xem cửa hàng Sticker biểu cảm' })
  getStickers() {
    return this.usersService.getStickerStore();
  }

  @Get('me/stickers')
  @ApiOperation({ summary: 'Kho sticker cá nhân sở hữu' })
  getMyStickers(@CurrentUser() user: any) {
    return this.usersService.getStickersInventory(user.id);
  }

  @Post('me/stickers/purchase')
  @ApiOperation({ summary: 'Mua sticker bằng điểm thưởng' })
  buySticker(@CurrentUser() user: any, @Body('stickerId') stickerId: string) {
    return this.usersService.purchaseSticker(user.id, stickerId);
  }

  @Get('me/followers')
  @ApiOperation({ summary: 'Danh sách bạn bè / người theo dõi' })
  getFollowers(@CurrentUser() user: any) {
    return this.usersService.getFollowers(user.id);
  }

  @Get('me/social-links')
  @ApiOperation({ summary: 'Lấy danh sách liên kết mạng xã hội' })
  getSocials(@CurrentUser() user: any) {
    return this.usersService.getSocialLinks(user.id);
  }

  @Patch('me/social-links')
  @ApiOperation({ summary: 'Cập nhật liên kết mạng xã hội' })
  updateSocials(@CurrentUser() user: any, @Body() body: any) {
    return this.usersService.updateSocialLinks(user.id, body);
  }

  @Get('me/stats')
  @ApiOperation({ summary: 'Thống kê chỉ số phượt thủ cá nhân' })
  getStats(@CurrentUser() user: any) {
    return this.usersService.getProfileStats(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem profile người dùng khác' })
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
