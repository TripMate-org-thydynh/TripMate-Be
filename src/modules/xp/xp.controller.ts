import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StoreService } from './store.service';
import { XpService } from './xp.service';

@ApiTags('XP & Store')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('xp')
export class XpController {
  constructor(
    private readonly xp: XpService,
    private readonly store: StoreService,
  ) {}

  @Get('wallet')
  @ApiOperation({ summary: 'Ví XP của tôi: số dư, tổng đã kiếm, cấp, lịch sử' })
  getWallet(@CurrentUser() user: User) {
    return this.xp.getWallet(user.id);
  }

  @Get('audit')
  @ApiOperation({ summary: 'Đối chiếu số dư với sổ cái (soát lỗi)' })
  audit(@CurrentUser() user: User) {
    return this.xp.audit(user.id);
  }

  @Get('stickers/store')
  @ApiOperation({ summary: 'Cửa hàng sticker kèm cờ đã sở hữu / đủ XP' })
  stickerStore(@CurrentUser() user: User) {
    return this.store.getStickerStore(user.id);
  }

  @Get('stickers/mine')
  @ApiOperation({ summary: 'Kho sticker đã sở hữu' })
  myStickers(@CurrentUser() user: User) {
    return this.store.getMyStickers(user.id);
  }

  @Post('stickers/purchase')
  @ApiOperation({ summary: 'Đổi XP lấy sticker' })
  buySticker(@CurrentUser() user: User, @Body('stickerId') stickerId: string) {
    return this.store.purchaseSticker(user.id, stickerId);
  }

  @Get('themes/store')
  @ApiOperation({ summary: 'Chợ theme kèm cờ đã mở khoá / đủ XP' })
  themeStore(@CurrentUser() user: User) {
    return this.store.getThemeMarketplace(user.id);
  }

  @Get('themes/mine')
  @ApiOperation({ summary: 'Theme đã mở khoá' })
  myThemes(@CurrentUser() user: User) {
    return this.store.getMyThemes(user.id);
  }

  @Post('themes/purchase')
  @ApiOperation({ summary: 'Đổi XP lấy theme' })
  buyTheme(@CurrentUser() user: User, @Body('themeId') themeId: string) {
    return this.store.purchaseTheme(user.id, themeId);
  }
}
