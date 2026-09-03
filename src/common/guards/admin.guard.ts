import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('errors.auth.unauthorized');
    }

    if (user.isLocked) {
      throw new ForbiddenException('errors.auth.user_locked');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('errors.auth.admin_required');
    }

    return true;
  }
}
