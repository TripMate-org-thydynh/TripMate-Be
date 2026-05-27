import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { I18nContext } from 'nestjs-i18n';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaClientExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const i18n = I18nContext.current(host);

    this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = i18n
      ? i18n.t('errors.database.unknown')
      : 'Database error occurred';

    switch (exception.code) {
      case 'P2002':
        status = HttpStatus.CONFLICT;
        const target = (exception.meta?.target as string[])?.join(', ') ?? '';
        message = i18n
          ? i18n.t('errors.database.duplicate', { args: { target } })
          : `Duplicate value: ${target} already exists`;
        break;
      case 'P2025':
        status = HttpStatus.NOT_FOUND;
        message = i18n
          ? i18n.t('errors.database.notFound')
          : 'Record not found';
        break;
      case 'P2003':
        status = HttpStatus.BAD_REQUEST;
        message = i18n
          ? i18n.t('errors.database.relatedNotFound')
          : 'Related record not found';
        break;
      case 'P2014':
        status = HttpStatus.BAD_REQUEST;
        message = i18n
          ? i18n.t('errors.database.invalidRelation')
          : 'Invalid relation';
        break;
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
