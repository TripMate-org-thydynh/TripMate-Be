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
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePresenceDto } from './dto/update-presence.dto';
import { UpdateSocialsDto } from './dto/update-socials.dto';

@ApiTags('Users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Lấy profile hiện tại' })
  getMe(@CurrentUser() user: User) {
    return this.usersService.findById(user.id);
  }

  @Get('me/trips')
  @ApiOperation({ summary: 'Lấy danh sách chuyến đi của tôi' })
  getMyTrips(@CurrentUser() user: User) {
    return this.usersService.getMyTrips(user.id);
  }

  @Get('me/buddies')
  @ApiOperation({
    summary: 'Những người đã đi chung chuyến với tôi (màn Danh sách bạn bè)',
  })
  getTravelBuddies(@CurrentUser() user: User) {
    return this.usersService.getTravelBuddies(user.id);
  }

  @Get('me/moments/recent')
  @ApiOperation({
    summary: 'Kỷ niệm mới nhất trên mọi chuyến của tôi (scrapbook ở màn Home)',
  })
  getRecentMoments(@CurrentUser() user: User) {
    return this.usersService.getRecentMoments(user.id);
  }

  @Get('me/activities/recent')
  @ApiOperation({
    summary: 'Hoạt động mới nhất trên mọi chuyến của tôi (marquee màn Home)',
  })
  getRecentActivities(@CurrentUser() user: User) {
    return this.usersService.getRecentActivities(user.id);
  }

  @Get('me/up-next')
  @ApiOperation({
    summary: 'Điểm lịch trình kế tiếp của tôi (thẻ "Up Next" màn Home)',
  })
  getUpNext(@CurrentUser() user: User) {
    return this.usersService.getUpNext(user.id);
  }

  @Get('me/expense-summary')
  @ApiOperation({
    summary: 'Tổng hợp chi tiêu trên mọi chuyến (khối "The Roast" màn Home)',
  })
  getExpenseSummary(@CurrentUser() user: User) {
    return this.usersService.getExpenseSummary(user.id);
  }

  @Delete('me')
  @ApiOperation({ summary: 'Xoá tài khoản (PDPD - quyền được xoá dữ liệu)' })
  deleteAccount(@CurrentUser() user: User) {
    return this.usersService.deleteAccount(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Cập nhật profile' })
  updateProfile(@CurrentUser() user: User, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Post('me/presence')
  @ApiOperation({ summary: 'Cập nhật trạng thái online/vị trí của tôi' })
  updatePresence(@CurrentUser() user: User, @Body() dto: UpdatePresenceDto) {
    return this.usersService.updatePresence(user.id, dto);
  }

  // --- MODULE 9 PROFILE FLOW ENDPOINTS ---

  @Get('me/badges')
  @ApiOperation({ summary: 'Lấy danh hiệu / cúp phượt thủ' })
  getBadges(@CurrentUser() user: User) {
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
  getMyStickers(@CurrentUser() user: User) {
    return this.usersService.getStickersInventory(user.id);
  }

  @Post('me/stickers/purchase')
  @ApiOperation({ summary: 'Mua sticker bằng điểm thưởng' })
  buySticker(@CurrentUser() user: User, @Body('stickerId') stickerId: string) {
    return this.usersService.purchaseSticker(user.id, stickerId);
  }

  @Get('me/followers')
  @ApiOperation({ summary: 'Danh sách bạn bè / người theo dõi' })
  getFollowers(@CurrentUser() user: User) {
    return this.usersService.getFollowers(user.id);
  }

  @Get('me/social-links')
  @ApiOperation({ summary: 'Lấy danh sách liên kết mạng xã hội' })
  getSocials(@CurrentUser() user: User) {
    return this.usersService.getSocialLinks(user.id);
  }

  @Patch('me/social-links')
  @ApiOperation({ summary: 'Cập nhật liên kết mạng xã hội' })
  updateSocials(@CurrentUser() user: User, @Body() dto: UpdateSocialsDto) {
    return this.usersService.updateSocialLinks(user.id, dto);
  }

  @Get('me/stats')
  @ApiOperation({ summary: 'Thống kê chỉ số phượt thủ cá nhân' })
  getStats(@CurrentUser() user: User) {
    return this.usersService.getProfileStats(user.id);
  }

  @Get('me/travel-atlas')
  @ApiOperation({ summary: 'Dữ liệu Travel Atlas: địa điểm, streak, marker' })
  getTravelAtlas(@CurrentUser() user: User) {
    return this.usersService.getTravelAtlas(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem profile người dùng khác' })
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
