/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { ResourceOwnerGuard } from './resource-owner.guard';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

describe('ResourceOwnerGuard', () => {
  let guard: ResourceOwnerGuard;
  let reflector: Reflector;
  let prisma: any;

  const OWNER_USER_ID = 'user-owner-1';
  const OTHER_USER_ID = 'user-other-2';
  const CREATOR_USER_ID = 'user-creator-3';
  const TRIP_ID = 'trip-1';
  const RESOURCE_ID = 'resource-1';

  beforeEach(() => {
    reflector = new Reflector();
    prisma = {
      packingItem: {
        findUnique: jest.fn(),
      },
      todoItem: {
        findUnique: jest.fn(),
      },
      expense: {
        findUnique: jest.fn(),
      },
      journalEntry: {
        findUnique: jest.fn(),
      },
      tripNote: {
        findUnique: jest.fn(),
      },
      reservation: {
        findUnique: jest.fn(),
      },
      moment: {
        findUnique: jest.fn(),
      },
      wishlistItem: {
        findUnique: jest.fn(),
      },
      tripDocument: {
        findUnique: jest.fn(),
      },
      trip: {
        findUnique: jest.fn(),
      },
    };
    guard = new ResourceOwnerGuard(reflector, prisma as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(
    userId: string,
    params: Record<string, string>,
  ): ExecutionContext {
    const request = { user: { id: userId }, params };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;
  }

  // --- No decorator → allow ---
  it('should allow when no @OwnedResource decorator is present', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    const ctx = createMockContext(OTHER_USER_ID, { itemId: RESOURCE_ID });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  // --- Owner → allow ---
  it('should allow when the user is the resource owner', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({
      model: 'packingItem',
      paramName: 'itemId',
    });
    prisma.packingItem.findUnique.mockResolvedValue({
      addedBy: OWNER_USER_ID,
      tripId: TRIP_ID,
    });

    const ctx = createMockContext(OWNER_USER_ID, { itemId: RESOURCE_ID });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  // --- Trip creator → allow ---
  it('should allow when the user is the trip creator (not resource owner)', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({
      model: 'packingItem',
      paramName: 'itemId',
    });
    prisma.packingItem.findUnique.mockResolvedValue({
      addedBy: OWNER_USER_ID,
      tripId: TRIP_ID,
    });
    prisma.trip.findUnique.mockResolvedValue({
      createdBy: CREATOR_USER_ID,
    });

    const ctx = createMockContext(CREATOR_USER_ID, { itemId: RESOURCE_ID });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  // --- Non-owner, non-creator → 403 ---
  it('should throw ForbiddenException for a member who is neither owner nor trip creator', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({
      model: 'packingItem',
      paramName: 'itemId',
    });
    prisma.packingItem.findUnique.mockResolvedValue({
      addedBy: OWNER_USER_ID,
      tripId: TRIP_ID,
    });
    prisma.trip.findUnique.mockResolvedValue({
      createdBy: CREATOR_USER_ID,
    });

    const ctx = createMockContext(OTHER_USER_ID, { itemId: RESOURCE_ID });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // --- Resource not found → 404 ---
  it('should throw NotFoundException when the resource does not exist', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({
      model: 'packingItem',
      paramName: 'itemId',
    });
    prisma.packingItem.findUnique.mockResolvedValue(null);

    const ctx = createMockContext(OWNER_USER_ID, { itemId: RESOURCE_ID });
    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  // --- Works for all supported models ---
  it.each([
    { model: 'expense', ownerField: 'paidById' },
    { model: 'journalEntry', ownerField: 'authorId' },
    { model: 'tripNote', ownerField: 'authorId' },
    { model: 'reservation', ownerField: 'addedBy' },
    { model: 'moment', ownerField: 'userId' },
    { model: 'todoItem', ownerField: 'addedBy' },
    { model: 'wishlistItem', ownerField: 'addedBy' },
    { model: 'tripDocument', ownerField: 'uploadedBy' },
  ])(
    'should enforce ownership for model $model (owner field: $ownerField)',
    async ({ model, ownerField }) => {
      jest.spyOn(reflector, 'get').mockReturnValue({
        model,
        paramName: 'id',
      });

      // Non-owner requesting
      prisma[model].findUnique.mockResolvedValue({
        [ownerField]: OWNER_USER_ID,
        tripId: TRIP_ID,
      });
      prisma.trip.findUnique.mockResolvedValue({
        createdBy: CREATOR_USER_ID,
      });

      const ctx = createMockContext(OTHER_USER_ID, { id: RESOURCE_ID });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    },
  );
});
