import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';

/** Cổng thanh toán có thể tạo đơn. */
export type Gateway = 'MOMO' | 'ZALOPAY';

/** Kết quả tạo đơn: chỗ để đẩy người dùng sang trả tiền. */
export interface CreatedOrder {
  /** Trang thanh toán mở bằng trình duyệt. */
  payUrl: string;
  /** Deep link mở thẳng app ví, nếu cổng có trả. */
  deeplink?: string;
  /** QR để quét bằng máy khác. */
  qrCodeUrl?: string;
  /** Mã giao dịch phía cổng, để đối soát. */
  gatewayRef?: string;
}

/**
 * Gọi cổng thanh toán để tạo đơn.
 *
 * Đây là mắt xích trước đây **hoàn toàn không tồn tại**: webhook Momo/ZaloPay
 * đã kiểm chữ ký đầy đủ và `buildOrderId()` đã có, nhưng không có chỗ nào tạo
 * đơn nên không cổng nào có lý do gọi webhook. Cả nhánh thanh toán ví đứng
 * yên ở 90%.
 *
 * Tách riêng khỏi `PremiumService` vì đây là phần duy nhất nói chuyện với thế
 * giới bên ngoài — cần thay bằng bản giả khi test mà không đụng tới logic cấp
 * quyền.
 */
@Injectable()
export class PaymentGatewayService {
  private readonly logger = new Logger(PaymentGatewayService.name);

  /** Cổng nào đã có đủ cấu hình để bán. Client hỏi trước khi vẽ nút. */
  availableGateways(): Gateway[] {
    const out: Gateway[] = [];
    if (this.momoConfig()) out.push('MOMO');
    if (this.zaloConfig()) out.push('ZALOPAY');
    return out;
  }

  private momoConfig() {
    const partnerCode = process.env.MOMO_PARTNER_CODE;
    const accessKey = process.env.MOMO_ACCESS_KEY;
    const secretKey = process.env.MOMO_SECRET_KEY;
    if (!partnerCode || !accessKey || !secretKey) return null;
    return {
      partnerCode,
      accessKey,
      secretKey,
      endpoint:
        process.env.MOMO_ENDPOINT ??
        'https://test-payment.momo.vn/v2/gateway/api/create',
    };
  }

  private zaloConfig() {
    const appId = process.env.ZALOPAY_APP_ID;
    const key1 = process.env.ZALOPAY_KEY1;
    if (!appId || !key1) return null;
    return {
      appId,
      key1,
      endpoint:
        process.env.ZALOPAY_ENDPOINT ??
        'https://sb-openapi.zalopay.vn/v2/create',
    };
  }

  /** Nơi cổng gọi lại khi trả tiền xong. Phải là URL công khai. */
  private ipnUrl(path: string): string {
    const base = process.env.PUBLIC_API_URL;
    if (!base) {
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }
    return `${base.replace(/\/+$/, '')}${path}`;
  }

  /** Nơi ví đẩy người dùng về sau khi trả xong. */
  private redirectUrl(): string {
    return process.env.PAYMENT_RETURN_URL ?? 'tripmate://premium/return';
  }

  async create(params: {
    gateway: Gateway;
    orderId: string;
    amount: number;
    description: string;
    userId: string;
  }): Promise<CreatedOrder> {
    return params.gateway === 'MOMO'
      ? this.createMomo(params)
      : this.createZaloPay(params);
  }

  /**
   * Momo `/v2/gateway/api/create`.
   *
   * Chuỗi ký của lệnh tạo đơn **khác** chuỗi ký của IPN — khác cả tập trường
   * lẫn thứ tự, và Momo sắp theo alphabet. Sai một trường là cổng trả
   * `resultCode: 21` (sai chữ ký) chứ không nói trường nào.
   */
  private async createMomo(params: {
    orderId: string;
    amount: number;
    description: string;
    userId: string;
  }): Promise<CreatedOrder> {
    const cfg = this.momoConfig();
    if (!cfg) {
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }

    const requestId = randomUUID();
    const ipnUrl = this.ipnUrl('/api/v1/payment/momo/ipn');
    const redirectUrl = this.redirectUrl();
    const requestType = 'captureWallet';
    const extraData = '';

    const raw =
      `accessKey=${cfg.accessKey}` +
      `&amount=${params.amount}` +
      `&extraData=${extraData}` +
      `&ipnUrl=${ipnUrl}` +
      `&orderId=${params.orderId}` +
      `&orderInfo=${params.description}` +
      `&partnerCode=${cfg.partnerCode}` +
      `&redirectUrl=${redirectUrl}` +
      `&requestId=${requestId}` +
      `&requestType=${requestType}`;
    const signature = createHmac('sha256', cfg.secretKey)
      .update(raw)
      .digest('hex');

    const body = {
      partnerCode: cfg.partnerCode,
      partnerName: 'TripMate',
      storeId: 'TripMate',
      requestId,
      amount: params.amount,
      orderId: params.orderId,
      orderInfo: params.description,
      redirectUrl,
      ipnUrl,
      lang: 'vi',
      requestType,
      extraData,
      signature,
    };

    const json = await this.postJson(cfg.endpoint, body);
    if (json?.resultCode !== 0) {
      this.logger.error(
        `Momo từ chối tạo đơn ${params.orderId}: ${json?.resultCode} ${json?.message}`,
      );
      throw new ServiceUnavailableException({
        code: 'GATEWAY_REJECTED',
        message: 'errors.premium.gatewayRejected',
      });
    }

    return {
      payUrl: json.payUrl,
      deeplink: json.deeplink,
      qrCodeUrl: json.qrCodeUrl,
      gatewayRef: String(json.requestId ?? requestId),
    };
  }

  /**
   * ZaloPay `/v2/create`.
   *
   * `app_trans_id` bị ZaloPay ép định dạng `yymmdd_<gì đó>` và giới hạn độ
   * dài, nên mã đơn của mình không nhét thẳng vào đó được — nó đi trong
   * `embed_data`, đúng chỗ webhook đang đọc ra (`embed.orderId`).
   */
  private async createZaloPay(params: {
    orderId: string;
    amount: number;
    description: string;
    userId: string;
  }): Promise<CreatedOrder> {
    const cfg = this.zaloConfig();
    if (!cfg) {
      throw new ServiceUnavailableException({
        code: 'GATEWAY_NOT_CONFIGURED',
        message: 'errors.premium.gatewayNotConfigured',
      });
    }

    const now = new Date();
    const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
    const appTransId = `${yymmdd}_${now.getTime()}`;
    const appTime = now.getTime();
    const embedData = JSON.stringify({
      orderId: params.orderId,
      redirecturl: this.redirectUrl(),
    });
    const item = '[]';

    const raw = [
      cfg.appId,
      appTransId,
      params.userId,
      params.amount,
      appTime,
      embedData,
      item,
    ].join('|');
    const mac = createHmac('sha256', cfg.key1).update(raw).digest('hex');

    const body = {
      app_id: Number(cfg.appId),
      app_trans_id: appTransId,
      app_user: params.userId,
      app_time: appTime,
      amount: params.amount,
      item,
      embed_data: embedData,
      description: params.description,
      callback_url: this.ipnUrl('/api/v1/payment/zalopay/ipn'),
      mac,
    };

    const json = await this.postJson(cfg.endpoint, body);
    if (json?.return_code !== 1) {
      this.logger.error(
        `ZaloPay từ chối tạo đơn ${params.orderId}: ${json?.return_code} ${json?.return_message} ${json?.sub_return_message ?? ''}`,
      );
      throw new ServiceUnavailableException({
        code: 'GATEWAY_REJECTED',
        message: 'errors.premium.gatewayRejected',
      });
    }

    return {
      payUrl: json.order_url,
      deeplink: json.order_url,
      qrCodeUrl: json.qr_code,
      gatewayRef: appTransId,
    };
  }

  /**
   * POST JSON có hạn thời gian.
   *
   * Không đặt timeout thì một cổng treo sẽ giữ luôn request của người dùng cho
   * tới khi Node bỏ cuộc — mặc định là hàng phút.
   */
  private async postJson(url: string, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await res.json();
    } catch (e) {
      this.logger.error(`Không gọi được cổng thanh toán ${url}: ${String(e)}`);
      throw new ServiceUnavailableException({
        code: 'GATEWAY_UNREACHABLE',
        message: 'errors.premium.gatewayUnreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
