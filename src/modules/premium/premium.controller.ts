import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PremiumService } from './premium.service';
import { TrialService } from './trial.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Premium')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('premium')
export class PremiumController {
  constructor(
    private readonly premiumService: PremiumService,
    private readonly trials: TrialService,
  ) {}

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

  @Get('trial')
  @ApiOperation({
    summary: 'Tình trạng dùng thử: còn hạn tới bao giờ, đã từng dùng chưa',
  })
  trialStatus(@CurrentUser() user: { id: string }) {
    return this.trials.status(user.id);
  }

  @Post('trial/start')
  @ApiOperation({ summary: 'Bắt đầu 3 ngày dùng thử' })
  startTrial(
    @CurrentUser() user: { id: string },
    @Ip() ip: string,
    @Body('deviceId') deviceId?: string,
  ) {
    // IP lấy từ tầng vận chuyển, không nhận từ thân request: client tự khai
    // thì tín hiệu mạng thành vô nghĩa. `deviceId` thì client vẫn bịa được —
    // đó là lý do nó chỉ là một trong nhiều tín hiệu, không phải chốt chặn.
    return this.trials.start(user.id, { ip, deviceId });
  }

  @Post('trial/cancel')
  @ApiOperation({ summary: 'Dừng dùng thử ngay' })
  cancelTrial(@CurrentUser() user: { id: string }) {
    return this.trials.cancel(user.id);
  }

  @Get('plans')
  @ApiOperation({ summary: 'Bảng giá và các cổng thanh toán đang mở' })
  plans() {
    return this.premiumService.plans();
  }

  @Post('orders')
  @ApiOperation({
    summary: 'Tạo đơn mua gói, trả về link/deeplink để trả tiền',
  })
  createOrder(
    @CurrentUser() user: { id: string },
    @Body('plan') plan: string,
    @Body('months') months: number,
    @Body('provider') provider: string,
    @Body('promoCode') promoCode?: string,
  ) {
    // Không nhận `amount` từ client: server tự tính theo bảng giá rồi tự áp
    // mã giảm giá. Client chỉ nói dùng mã NÀO, không nói giảm BAO NHIÊU.
    return this.premiumService.createOrder(
      user.id,
      plan,
      months,
      provider,
      promoCode,
    );
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Trạng thái một đơn, dùng để chờ webhook về' })
  getOrder(
    @CurrentUser() user: { id: string },
    @Param('orderId') orderId: string,
  ) {
    return this.premiumService.getOrder(user.id, orderId);
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

  @Get('referrals/me')
  @ApiOperation({ summary: 'Mã giới thiệu của tôi kèm số bạn đã mời' })
  myReferral(@CurrentUser() user: { id: string }) {
    return this.premiumService.myReferral(user.id);
  }

  @Get('referrals/status')
  @ApiOperation({ summary: 'Tôi đã nhập mã của ai chưa' })
  referralStatus(@CurrentUser() user: { id: string }) {
    return this.premiumService.referralStatus(user.id);
  }

  @Post('referrals')
  @ApiOperation({ summary: 'Nhập mã giới thiệu bạn bè nhận XP' })
  submitReferral(
    @CurrentUser() user: { id: string },
    @Body('code') code: string,
  ) {
    return this.premiumService.submitReferral(user.id, code);
  }

  @Get('promo-codes')
  @ApiOperation({ summary: 'Các mã giảm giá đang chạy' })
  activePromos() {
    return this.premiumService.activePromos();
  }

  @Post('promo-codes/validate')
  @ApiOperation({
    summary: 'Kiểm mã giảm giá, trả về số tiền được giảm cho gói đã chọn',
  })
  validatePromoCode(
    @CurrentUser() user: { id: string },
    @Body('code') code: string,
    @Body('plan') plan?: string,
    @Body('months') months?: number,
  ) {
    // Cần `userId` để kiểm giới hạn mỗi người — bản trước không nhận, nên mã
    // giới hạn một lần/người không kiểm được.
    return this.premiumService.validatePromoCode(code, user.id, plan, months);
  }

  @Get('creator-revenue')
  @ApiOperation({
    summary: 'Lấy doanh thu chia sẻ của nhà sáng tạo theme/sticker',
  })
  getCreatorRevenue(@CurrentUser() user: { id: string }) {
    return this.premiumService.getCreatorRevenue(user.id);
  }
}
