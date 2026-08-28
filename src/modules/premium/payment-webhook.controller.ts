import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PremiumService } from './premium.service';

@ApiTags('Payment Webhook')
@Controller('payment')
export class PaymentWebhookController {
  constructor(private readonly premiumService: PremiumService) {}

  @Post('momo/ipn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Momo Payment IPN Webhook' })
  handleMomoIpn(@Body() body: any) {
    return this.premiumService.handleMomoIpn(body);
  }

  @Post('zalopay/ipn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ZaloPay Payment IPN Webhook' })
  handleZaloPayIpn(@Body() body: any) {
    return this.premiumService.handleZaloPayIpn(body);
  }
}
