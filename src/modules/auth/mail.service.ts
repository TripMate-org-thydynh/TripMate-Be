import { Injectable, Logger } from '@nestjs/common';

/**
 * Gửi email qua SendGrid REST API v3 (dùng fetch, không cần SDK) — mirror
 * cách TwilioService gọi API. Thiếu SENDGRID_API_KEY/EMAIL_FROM → mock ra log
 * để môi trường dev không bị kẹt luồng.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async sendEmail(to: string, subject: string, text: string): Promise<boolean> {
    const apiKey = process.env.SENDGRID_API_KEY;
    const from = process.env.EMAIL_FROM;
    const fromName = process.env.EMAIL_FROM_NAME ?? 'TripMate';

    if (!apiKey || !from) {
      this.logger.warn(
        'SendGrid chưa cấu hình (SENDGRID_API_KEY/EMAIL_FROM). Email sẽ được mock.',
      );
      this.logger.log(`[MOCK EMAIL] To: ${to} | ${subject} | ${text}`);
      return true;
    }

    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to.trim() }] }],
          from: { email: from, name: fromName },
          subject,
          content: [{ type: 'text/plain', value: text }],
        }),
      });

      // SendGrid trả 202 Accepted khi nhận email thành công.
      if (response.status === 202) {
        this.logger.log(`SendGrid email đã gửi tới ${to}`);
        return true;
      }

      const errText = await response.text();
      this.logger.error(
        `SendGrid thất bại (status ${response.status}): ${errText}`,
      );
      return false;
    } catch (e) {
      this.logger.error(`SendGrid exception: ${e.message}`, e.stack);
      return false;
    }
  }
}
