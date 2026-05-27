import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
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
  getSubscriptions(@CurrentUser() user: any) {
    return this.premiumService.getSubscriptions(user.id);
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Thực hiện thanh toán nâng cấp Premium' })
  checkout(
    @CurrentUser() user: any,
    @Body('tier') tier: string,
    @Body('paymentMethod') paymentMethod: string,
  ) {
    return this.premiumService.checkout(user.id, tier, paymentMethod);
  }

  @Get('billing-history')
  @ApiOperation({ summary: 'Lấy lịch sử thanh toán hóa đơn' })
  getBillingHistory(@CurrentUser() user: any) {
    return this.premiumService.getBillingHistory(user.id);
  }

  @Post('referrals')
  @ApiOperation({ summary: 'Nhập mã giới thiệu bạn bè nhận XP' })
  submitReferral(@CurrentUser() user: any, @Body('code') code: string) {
    return this.premiumService.submitReferral(user.id, code);
  }

  @Post('promo-codes/validate')
  @ApiOperation({ summary: 'Kiểm tra mã giảm giá' })
  validatePromoCode(@Body('code') code: string) {
    return this.premiumService.validatePromoCode(code);
  }

  @Get('creator-revenue')
  @ApiOperation({ summary: 'Lấy doanh thu chia sẻ của nhà sáng tạo theme/sticker' })
  getCreatorRevenue(@CurrentUser() user: any) {
    return this.premiumService.getCreatorRevenue(user.id);
  }
}
