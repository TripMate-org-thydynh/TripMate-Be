import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { I18nContext } from 'nestjs-i18n';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const i18n = I18nContext.current(host);

    const exceptionResponse = exception.getResponse() as any;
    let message: any = exception.message;

    // Handle standard NestJS validation arrays or object responses
    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      if (Array.isArray(exceptionResponse.message)) {
        message = exceptionResponse.message.join(', ');
      } else if (exceptionResponse.message) {
        message = exceptionResponse.message;
      }
    }

    // Translate key if it's defined in i18n JSONs
    if (i18n && typeof message === 'string') {
      try {
        const translated = i18n.t(message);
        if (translated && translated !== message) {
          message = translated;
        }
      } catch (err) {
        this.logger.warn(`Failed to translate key "${message}": ${err.message || err}`);
      }
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
