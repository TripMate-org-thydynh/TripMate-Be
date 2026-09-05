import { Test, TestingModule } from '@nestjs/testing';
import { PackingService } from './packing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictException } from '@nestjs/common';

describe('PackingService — optimistic concurrency', () => {
  let service: PackingService;

  const ITEM_ID = 'item-1';
  const USER_ID = 'user-1';
  const TRIP_ID = 'trip-1';
  const DB_UPDATED_AT = new Date('2026-07-20T10:00:00.000Z');

  const mockPrisma = {
    packingItem: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    trip: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PackingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PackingService>(PackingService);
    jest.clearAllMocks();
  });

  it('should throw ConflictException (409) when client updatedAt does not match DB', async () => {
    mockPrisma.packingItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isPacked: false,
      updatedAt: DB_UPDATED_AT,
    });

    // Client sends a stale updatedAt (1 hour behind)
    const staleDate = new Date('2026-07-20T09:00:00.000Z').toISOString();
    await expect(
      service.updateItem(ITEM_ID, USER_ID, {
        isPacked: true,
        updatedAt: staleDate,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should succeed when client updatedAt matches DB', async () => {
    mockPrisma.packingItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isPacked: false,
      updatedAt: DB_UPDATED_AT,
    });

    const updatedItem = {
      id: ITEM_ID,
      isPacked: true,
      updatedAt: new Date(),
    };
    mockPrisma.packingItem.update.mockResolvedValue(updatedItem);

    const result = await service.updateItem(ITEM_ID, USER_ID, {
      isPacked: true,
      updatedAt: DB_UPDATED_AT.toISOString(),
    });

    expect(result).toEqual(updatedItem);
    expect(mockPrisma.packingItem.update).toHaveBeenCalled();
  });

  it('should succeed when client does NOT send updatedAt (backward compatible)', async () => {
    mockPrisma.packingItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isPacked: false,
      updatedAt: DB_UPDATED_AT,
    });

    const updatedItem = {
      id: ITEM_ID,
      isPacked: true,
      updatedAt: new Date(),
    };
    mockPrisma.packingItem.update.mockResolvedValue(updatedItem);

    // No updatedAt in DTO — should bypass concurrency check
    const result = await service.updateItem(ITEM_ID, USER_ID, {
      isPacked: true,
    });

    expect(result).toEqual(updatedItem);
    expect(mockPrisma.packingItem.update).toHaveBeenCalled();
  });
});
