import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PremiumService } from './premium.service';
import { RawResponse } from '../../common/interceptors/transform.interceptor';

@SkipThrottle()
@ApiTags('Payment Webhook')
@Controller('payment')
export class PaymentWebhookController {
  constructor(private readonly premiumService: PremiumService) {}

  @Get('order-status/:orderCode')
  @ApiOperation({ summary: 'Kiểm tra trạng thái đơn hàng công khai' })
  getOrderStatus(@Param('orderCode') orderCode: string) {
    return this.premiumService.getPublicOrderStatus(orderCode);
  }

  @RawResponse()
  @Post('momo/ipn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Momo Payment IPN Webhook' })
  handleMomoIpn(@Body() body: any) {
    return this.premiumService.handleMomoIpn(body);
  }

  @RawResponse()
  @Post('zalopay/ipn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'ZaloPay Payment IPN Webhook' })
  handleZaloPayIpn(@Body() body: any) {
    return this.premiumService.handleZaloPayIpn(body);
  }

  @RawResponse()
  @Post(['sepay/webhook', 'webhook/sepay'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SePay VietQR Payment Webhook' })
  handleSepayWebhook(
    @Body() body: any,
    @Headers('authorization') authHeader?: string,
    @Headers('x-api-key') apiKeyHeader?: string,
  ) {
    return this.premiumService.handleSepayWebhook(
      body,
      authHeader || apiKeyHeader,
    );
  }
}

