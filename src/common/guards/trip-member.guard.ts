import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TripRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TRIP_ROLES_KEY } from '../decorators/trip-member.decorator';

@Injectable()
export class TripMemberGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<TripRole[]>(
      TRIP_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const tripId = request.params.tripId;

    if (!tripId) return true;

    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId: user.id } },
    });

    if (!member) {
      throw new NotFoundException('errors.auth.notMember');
    }

    if (requiredRoles && !requiredRoles.includes(member.role)) {
      throw new ForbiddenException('errors.auth.forbidden');
    }

    request.tripMember = member;
    return true;
  }
}
