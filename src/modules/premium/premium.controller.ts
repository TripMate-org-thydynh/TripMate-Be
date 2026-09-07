import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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

  @Get('entitlement')
  @ApiOperation({
    summary: 'Quyền hiện tại: gói, hạn dùng và hạn mức từng loại',
  })
  entitlement(@CurrentUser() user: { id: string }) {
    return this.premiumService.entitlement(user.id);
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Huỷ gia hạn, vẫn dùng tới hết kỳ đã trả' })
  cancel(@CurrentUser() user: { id: string }) {
    return this.premiumService.cancelSubscription(user.id);
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Thực hiện thanh toán nâng cấp Premium' })
  checkout(
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      plan?: string;
      tier?: string;
      months?: number;
      paymentMethod?: string;
      redirectUrl?: string;
    },
  ) {
    return this.premiumService.checkout(user.id, body);
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

  @Get('order-status/:orderCode')
  @ApiOperation({ summary: 'Kiểm tra trạng thái đơn hàng thời gian thực' })
  getOrderStatus(
    @CurrentUser() user: { id: string },
    @Param('orderCode') orderCode: string,
  ) {
    return this.premiumService.getOrderStatus(user.id, orderCode);
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
