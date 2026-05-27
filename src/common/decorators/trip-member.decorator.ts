import { SetMetadata } from '@nestjs/common';
import { TripRole } from '@prisma/client';

export const TRIP_ROLES_KEY = 'tripRoles';
export const TripRoles = (...roles: TripRole[]) =>
  SetMetadata(TRIP_ROLES_KEY, roles);
