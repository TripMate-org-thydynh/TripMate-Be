import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@prisma/client';
import { RequestWithUser } from '../types/request-with-user';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
