/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Test, TestingModule } from '@nestjs/testing';
import { TodosService } from './todos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictException } from '@nestjs/common';

describe('TodosService — optimistic concurrency', () => {
  let service: TodosService;

  const ITEM_ID = 'todo-1';
  const USER_ID = 'user-1';
  const TRIP_ID = 'trip-1';
  const DB_UPDATED_AT = new Date('2026-07-20T10:00:00.000Z');

  const mockPrisma = {
    todoItem: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
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
        TodosService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TodosService>(TodosService);
    jest.clearAllMocks();
  });

  it('should throw ConflictException (409) when client updatedAt does not match DB', async () => {
    mockPrisma.todoItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isDone: false,
      updatedAt: DB_UPDATED_AT,
    });

    const staleDate = new Date('2026-07-20T09:00:00.000Z').toISOString();
    await expect(
      service.updateItem(ITEM_ID, USER_ID, {
        isDone: true,
        updatedAt: staleDate,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should succeed when client updatedAt matches DB', async () => {
    mockPrisma.todoItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isDone: false,
      updatedAt: DB_UPDATED_AT,
    });

    const updatedItem = {
      id: ITEM_ID,
      isDone: true,
      updatedAt: new Date(),
    };
    mockPrisma.todoItem.update.mockResolvedValue(updatedItem);

    const result = await service.updateItem(ITEM_ID, USER_ID, {
      isDone: true,
      updatedAt: DB_UPDATED_AT.toISOString(),
    });

    expect(result).toEqual(updatedItem);
    expect(mockPrisma.todoItem.update).toHaveBeenCalled();
  });

  it('should succeed when client does NOT send updatedAt (backward compatible)', async () => {
    mockPrisma.todoItem.findUnique.mockResolvedValue({
      id: ITEM_ID,
      addedBy: USER_ID,
      tripId: TRIP_ID,
      isDone: false,
      updatedAt: DB_UPDATED_AT,
    });

    const updatedItem = {
      id: ITEM_ID,
      isDone: true,
      updatedAt: new Date(),
    };
    mockPrisma.todoItem.update.mockResolvedValue(updatedItem);

    const result = await service.updateItem(ITEM_ID, USER_ID, {
      isDone: true,
    });

    expect(result).toEqual(updatedItem);
    expect(mockPrisma.todoItem.update).toHaveBeenCalled();
  });
});
