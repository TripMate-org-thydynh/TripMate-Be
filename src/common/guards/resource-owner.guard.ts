import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OWNED_RESOURCE_KEY,
  OwnedResourceMeta,
} from '../decorators/resource-owner.decorator';

/**
 * Mapping from Prisma model name to the field that stores the owner's userId.
 * Only models listed here are supported by ResourceOwnerGuard.
 */
const OWNER_FIELD_MAP: Record<string, string> = {
  expense: 'paidById',
  packingItem: 'addedBy',
  todoItem: 'addedBy',
  journalEntry: 'authorId',
  tripNote: 'authorId',
  reservation: 'addedBy',
  moment: 'userId',
  wishlistItem: 'addedBy',
  tripDocument: 'uploadedBy',
};

/**
 * Guard that verifies the current user owns the target resource **or** is the
 * trip creator.  Attach with the `@OwnedResource(model, paramName)` decorator.
 *
 * Runs AFTER JwtAuthGuard + TripMemberGuard so `request.user` is guaranteed.
 */
@Injectable()
export class ResourceOwnerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<OwnedResourceMeta>(
      OWNED_RESOURCE_KEY,
      context.getHandler(),
    );

    // No decorator → allow (guard is opt-in per handler)
    if (!meta) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const resourceId: string | undefined = request.params[meta.paramName];

    // Fail-closed: Thiếu resourceId trong request params -> từ chối truy cập để tránh lọt quyền
    if (!resourceId) {
      throw new ForbiddenException('errors.auth.forbidden');
    }

    const ownerField = OWNER_FIELD_MAP[meta.model];
    // Fail-closed: Model chưa được khai báo trong OWNER_FIELD_MAP (lỗi cấu hình backend, không được bỏ qua)
    if (!ownerField) {
      throw new InternalServerErrorException(
        `Model ${meta.model} chưa được cấu hình quyền sở hữu trong OWNER_FIELD_MAP`,
      );
    }

    // Dynamically query the Prisma model
    const delegate = (this.prisma as any)[meta.model];
    // Fail-closed: Model không tồn tại trên Prisma hoặc thiếu delegate.findUnique (lỗi cấu hình backend)
    if (!delegate?.findUnique) {
      throw new InternalServerErrorException(
        `Prisma delegate cho model ${meta.model} không hợp lệ`,
      );
    }

    const resource = await delegate.findUnique({
      where: { id: resourceId },
      select: { [ownerField]: true, tripId: true },
    });

    if (!resource) {
      throw new NotFoundException('errors.database.notFound');
    }

    // 1) Owner check
    if (resource[ownerField] === user.id) return true;

    // 2) Trip-creator check
    if (resource.tripId) {
      const trip = await this.prisma.trip.findUnique({
        where: { id: resource.tripId },
        select: { createdBy: true },
      });
      if (trip && trip.createdBy === user.id) return true;
    }

    throw new ForbiddenException('errors.auth.notOwner');
  }
}
