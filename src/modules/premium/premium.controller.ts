import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PremiumService } from './premium.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Premium')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('premium')
export class PremiumController {
  constructor(private readonly premiumService: PremiumService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'Lấy trạng thái gói Premium hiện tại' })
  getSubscriptions(@CurrentUser() user: { id: string }) {
    return this.premiumService.getSubscriptions(user.id);
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Thực hiện thanh toán nâng cấp Premium' })
  checkout(
    @CurrentUser() user: { id: string },
    @Body('tier') tier: string,
    @Body('paymentMethod') paymentMethod: string,
  ) {
    return this.premiumService.checkout(user.id, tier, paymentMethod);
  }

  @Post('verify-google-play')
  @ApiOperation({
    summary: 'Xác thực biên lai thanh toán từ Google Play (CH Play)',
  })
  verifyGooglePlay(
    @CurrentUser() user: { id: string },
    @Body('token') token: string,
    @Body('productId') productId: string,
  ) {
    return this.premiumService.verifyGooglePlayPurchase(
      user.id,
      token,
      productId,
    );
  }

  @Get('billing-history')
  @ApiOperation({ summary: 'Lấy lịch sử thanh toán hóa đơn' })
  getBillingHistory(@CurrentUser() user: { id: string }) {
    return this.premiumService.getBillingHistory(user.id);
  }

  @Post('referrals')
  @ApiOperation({ summary: 'Nhập mã giới thiệu bạn bè nhận XP' })
  submitReferral(
    @CurrentUser() user: { id: string },
    @Body('code') code: string,
  ) {
    return this.premiumService.submitReferral(user.id, code);
  }

  @Post('promo-codes/validate')
  @ApiOperation({ summary: 'Kiểm tra mã giảm giá' })
  validatePromoCode(@Body('code') code: string) {
    return this.premiumService.validatePromoCode(code);
  }

  @Get('creator-revenue')
  @ApiOperation({
    summary: 'Lấy doanh thu chia sẻ của nhà sáng tạo theme/sticker',
  })
  getCreatorRevenue(@CurrentUser() user: { id: string }) {
    return this.premiumService.getCreatorRevenue(user.id);
  }
}
