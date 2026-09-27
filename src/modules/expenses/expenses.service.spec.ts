/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Test, TestingModule } from '@nestjs/testing';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

import { AiService } from '../ai/ai.service';
import { ActivitiesService } from '../activities/activities.service';

describe('ExpensesService', () => {
  let service: ExpensesService;
  let prisma: PrismaService;

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(null),
  };

  const mockAiService = {
    scanReceiptImage: jest.fn().mockResolvedValue({
      merchant: 'Test Restaurant',
      total: 100000,
    }),
  };

  const mockPrismaService = {
    tripMember: {
      findMany: jest.fn(),
    },
    expense: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    expenseSplit: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    userWallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    linkedBank: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    paymentCard: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    budgetGoal: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const mockActivitiesService = {
    log: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AiService, useValue: mockAiService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: ActivitiesService, useValue: mockActivitiesService },
      ],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should split equally between all trip members for EQUAL splitType', async () => {
      const tripId = 'trip-1';
      const dto = {
        amount: 300,
        paidById: 'user-1',
        category: 'FOOD' as any,
        description: 'Lẩu cua đồng',
        splitType: 'EQUAL' as any,
      };

      // 3 members
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
        { userId: 'user-3' },
      ]);

      mockPrismaService.expense.create.mockImplementation(({ data }) => {
        return Promise.resolve({
          id: 'exp-1',
          ...data,
        });
      });

      const result = await service.create(tripId, dto);

      expect(prisma.tripMember.findMany).toHaveBeenCalledWith({
        where: { tripId },
        select: { userId: true },
      });

      expect(prisma.expense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: new Decimal(300),
            splitType: 'EQUAL',
          }),
        }),
      );

      expect(result).toBeDefined();
    });

    it('chia đều chỉ trong nhóm nhỏ khi có participantIds', async () => {
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
        { userId: 'user-3' },
        { userId: 'user-4' },
      ]);
      mockPrismaService.expense.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'exp-1', ...data }),
      );

      await service.create('trip-1', {
        amount: 300,
        paidById: 'user-1',
        category: 'FOOD' as any,
        splitType: 'EQUAL' as any,
        participantIds: ['user-1', 'user-2'],
      });

      const created = mockPrismaService.expense.create.mock.calls.at(-1)[0];
      const rows = created.data.splits.create;
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => r.userId).sort()).toEqual([
        'user-1',
        'user-2',
      ]);
      // 300 chia 2 người tham gia, không phải 4 người của chuyến.
      expect(rows[0].shareAmount).toEqual(new Decimal(150));
      expect(rows[1].shareAmount).toEqual(new Decimal(150));
    });

    it('phần lẻ dồn vào người trả, không phụ thuộc thứ tự bấm', async () => {
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'an' },
        { userId: 'binh' },
        { userId: 'chi' },
      ]);
      mockPrismaService.expense.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'exp-r', ...data }),
      );

      // 1.000.000 chia 3 = 333333.33 x3 = 999999.99, thiếu 0.01.
      // Bình trả, nhưng đứng GIỮA danh sách.
      await service.create('trip-1', {
        amount: 1000000,
        paidById: 'binh',
        category: 'ACTIVITIES' as any,
        splitType: 'EQUAL' as any,
        participantIds: ['an', 'binh', 'chi'],
      });

      const rows =
        mockPrismaService.expense.create.mock.calls.at(-1)[0].data.splits
          .create;
      const by = Object.fromEntries(
        rows.map((r: any) => [r.userId, r.shareAmount.toString()]),
      );
      expect(by).toEqual({
        an: '333333.33',
        binh: '333333.34',
        chi: '333333.33',
      });
    });

    it('người trả không tham gia thì phần lẻ dồn người đầu', async () => {
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'an' },
        { userId: 'binh' },
        { userId: 'chi' },
      ]);
      mockPrismaService.expense.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'exp-r2', ...data }),
      );

      // An mời cà phê: An trả nhưng không nằm trong nhóm chia.
      await service.create('trip-1', {
        amount: 100,
        paidById: 'an',
        category: 'FOOD' as any,
        splitType: 'EQUAL' as any,
        participantIds: ['binh', 'chi'],
      });

      const rows =
        mockPrismaService.expense.create.mock.calls.at(-1)[0].data.splits
          .create;
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.userId !== 'an')).toBe(true);
      const sum = rows.reduce(
        (a: any, r: any) => a.add(r.shareAmount),
        new Decimal(0),
      );
      expect(sum).toEqual(new Decimal(100));
    });

    it('từ chối participantIds có người ngoài chuyến', async () => {
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
      ]);
      await expect(
        service.create('trip-1', {
          amount: 100,
          paidById: 'user-1',
          category: 'FOOD' as any,
          splitType: 'EQUAL' as any,
          participantIds: ['user-1', 'nguoi-la'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('bỏ trống participantIds thì vẫn chia cả nhóm như cũ', async () => {
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
        { userId: 'user-3' },
      ]);
      mockPrismaService.expense.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'exp-2', ...data }),
      );

      await service.create('trip-1', {
        amount: 300,
        paidById: 'user-1',
        category: 'FOOD' as any,
        splitType: 'EQUAL' as any,
      });

      const created = mockPrismaService.expense.create.mock.calls.at(-1)[0];
      expect(created.data.splits.create).toHaveLength(3);
    });

    it('should throw BadRequestException if PERCENTAGE splits do not sum to 100', async () => {
      const tripId = 'trip-1';
      const dto = {
        amount: 100,
        paidById: 'user-1',
        category: 'FOOD' as any,
        description: 'Snacks',
        splitType: 'PERCENTAGE' as any,
        splits: [
          { userId: 'user-1', amount: 50 },
          { userId: 'user-2', amount: 40 }, // sums to 90
        ],
      };

      await expect(service.create(tripId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should split by custom percentages for PERCENTAGE splitType', async () => {
      const tripId = 'trip-1';
      const dto = {
        amount: 500,
        paidById: 'user-1',
        category: 'ACCOMMODATION' as any,
        description: 'Villa Dalat',
        splitType: 'PERCENTAGE' as any,
        splits: [
          { userId: 'user-1', amount: 60 },
          { userId: 'user-2', amount: 40 },
        ],
      };

      mockPrismaService.expense.create.mockImplementation(({ data }) => {
        return Promise.resolve({ id: 'exp-2', ...data });
      });

      const result = await service.create(tripId, dto);

      expect(result).toBeDefined();
      expect(prisma.expense.create).toHaveBeenCalled();
    });
  });

  describe('getBalances', () => {
    it('should correctly calculate balances and simplify debts', async () => {
      const tripId = 'trip-1';

      // 3 members
      mockPrismaService.tripMember.findMany.mockResolvedValue([
        { userId: 'user-1', user: { id: 'user-1', name: 'User 1' } },
        { userId: 'user-2', user: { id: 'user-2', name: 'User 2' } },
        { userId: 'user-3', user: { id: 'user-3', name: 'User 3' } },
      ]);

      // Mock expenses:
      // Expense 1: User 1 paid 300, split EQUAL between user-1, user-2, user-3 (100 each).
      // Expense 2: User 2 paid 150, split EQUAL between user-1, user-2, user-3 (50 each).
      mockPrismaService.expense.findMany.mockResolvedValue([
        {
          id: 'exp-1',
          amount: new Decimal(300),
          paidById: 'user-1',
          splits: [
            { userId: 'user-1', shareAmount: new Decimal(100) },
            { userId: 'user-2', shareAmount: new Decimal(100) },
            { userId: 'user-3', shareAmount: new Decimal(100) },
          ],
        },
        {
          id: 'exp-2',
          amount: new Decimal(150),
          paidById: 'user-2',
          splits: [
            { userId: 'user-1', shareAmount: new Decimal(50) },
            { userId: 'user-2', shareAmount: new Decimal(50) },
            { userId: 'user-3', shareAmount: new Decimal(50) },
          ],
        },
      ]);

      const result = await service.getBalances(tripId);

      // Math Check:
      // User 1 balance: paid 300, split share owed 100 + 50 = 150. Net balance: +150
      // User 2 balance: paid 150, split share owed 100 + 50 = 150. Net balance: 0
      // User 3 balance: paid 0, split share owed 100 + 50 = 150. Net balance: -150
      // Settlements should simplify: User 3 pays User 1 exactly 150.
      type BalanceRow = { user?: { id?: string }; balance: number };
      expect(
        result.balances.find((b: BalanceRow) => b.user?.id === 'user-1')
          ?.balance,
      ).toEqual(150);
      expect(
        result.balances.find((b: BalanceRow) => b.user?.id === 'user-2')
          ?.balance,
      ).toEqual(0);
      expect(
        result.balances.find((b: BalanceRow) => b.user?.id === 'user-3')
          ?.balance,
      ).toEqual(-150);

      expect(result.settlements).toHaveLength(1);
      expect(result.settlements[0].from.id).toEqual('user-3');
      expect(result.settlements[0].to.id).toEqual('user-1');
      expect(result.settlements[0].amount).toEqual(150);
    });
  });
});
