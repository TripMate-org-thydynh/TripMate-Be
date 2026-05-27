import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);

  async sendSms(to: string, message: string): Promise<boolean> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      this.logger.warn(
        'Twilio credentials not fully configured. Twilio SMS sending will be mocked.',
      );
      this.logger.log(`[MOCK SMS] To: ${to} | Message: ${message}`);
      return true;
    }

    try {
      // Ensure the "to" number has correct format (e.g. +84...)
      let formattedTo = to.trim();
      if (formattedTo.startsWith('0')) {
        formattedTo = '+84' + formattedTo.substring(1);
      } else if (!formattedTo.startsWith('+')) {
        formattedTo = '+' + formattedTo;
      }

      this.logger.log(`Sending Twilio SMS to ${formattedTo}...`);

      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString(
        'base64',
      );

      const response = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: formattedTo,
          From: fromNumber,
          Body: message,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        this.logger.error(`Twilio API failed with status ${response.status}: ${errText}`);
        return false;
      }

      const resData = await response.json();
      this.logger.log(`Twilio SMS successfully sent! SID: ${resData.sid}`);
      return true;
    } catch (e) {
      this.logger.error(`Twilio SMS sending exception: ${e.message}`, e.stack);
      return false;
    }
  }
}
