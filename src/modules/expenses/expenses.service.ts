import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { AiService } from '../ai/ai.service';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly activities: ActivitiesService,
  ) {}

  async create(tripId: string, dto: CreateExpenseDto) {
    // Get trip members for EQUAL split
    const members = await this.prisma.tripMember.findMany({
      where: { tripId },
      select: { userId: true },
    });

    const totalAmount = new Decimal(dto.amount);
    let splits: Array<{ userId: string; shareAmount: Decimal }>;

    if (dto.splitType === 'EQUAL') {
      const perPerson = totalAmount.div(members.length).toDecimalPlaces(2);
      splits = members.map((m) => ({
        userId: m.userId,
        shareAmount: perPerson,
      }));
    } else if (dto.splitType === 'EXACT' || dto.splitType === 'PERCENTAGE') {
      if (!dto.splits || dto.splits.length === 0) {
        throw new BadRequestException(
          'splits array is required for EXACT/PERCENTAGE splitType',
        );
      }
      if (dto.splitType === 'PERCENTAGE') {
        const totalPct = dto.splits.reduce((s, x) => s + x.amount, 0);
        if (Math.abs(totalPct - 100) > 0.01) {
          throw new BadRequestException('Percentages must sum to 100');
        }
        splits = dto.splits.map((s) => ({
          userId: s.userId,
          shareAmount: totalAmount.mul(s.amount).div(100).toDecimalPlaces(2),
        }));
      } else {
        splits = dto.splits.map((s) => ({
          userId: s.userId,
          shareAmount: new Decimal(s.amount),
        }));
      }
    } else {
      splits = [];
    }

    const expense = await this.prisma.expense.create({
      data: {
        tripId,
        paidById: dto.paidById,
        amount: totalAmount,
        category: dto.category,
        description: dto.description,
        splitType: dto.splitType,
        receiptUrl: dto.receiptUrl,
        splits: {
          create: splits.map((s) => ({
            userId: s.userId,
            shareAmount: s.shareAmount,
            isPaid: s.userId === dto.paidById,
            paidAt: s.userId === dto.paidById ? new Date() : null,
          })),
        },
      },
      include: {
        paidBy: { select: { id: true, name: true, avatarUrl: true } },
        splits: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    await this.evictCache(tripId);
    // Ghi nhật ký hoạt động để feed squad có dữ liệu — trước đây
    // ActivitiesService.log() không được gọi ở bất kỳ đâu.
    await this.activities.log(
      tripId,
      dto.paidById,
      'EXPENSE_ADDED',
      {
        amount: Number(dto.amount),
        description: dto.description ?? null,
      },
      expense.id,
    );
    return expense;
  }

  async findAll(tripId: string) {
    const cacheKey = `trip:${tripId}:expenses`;
    try {
      const cached = await this.cacheManager.get<any[]>(cacheKey);
      if (cached) return cached;
    } catch (e) {
      console.error('Redis cache get error:', e.message);
    }

    const expenses = await this.prisma.expense.findMany({
      where: { tripId, deletedAt: null },
      include: {
        paidBy: { select: { id: true, name: true, avatarUrl: true } },
        splits: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    try {
      await this.cacheManager.set(cacheKey, expenses, 300000);
    } catch (e) {
      console.error('Redis cache set error:', e.message);
    }

    return expenses;
  }

  async findAllPaginated(tripId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const where = { tripId, deletedAt: null } as const;

    const [total, items] = await Promise.all([
      this.prisma.expense.count({ where }),
      this.prisma.expense.findMany({
        where,
        include: {
          paidBy: { select: { id: true, name: true, avatarUrl: true } },
          splits: {
            include: {
              user: { select: { id: true, name: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  async getBalances(tripId: string) {
    const cacheKey = `trip:${tripId}:balances`;
    try {
      const cached = await this.cacheManager.get<any>(cacheKey);
      if (cached) return cached;
    } catch (e) {
      console.error('Redis cache get error:', e.message);
    }

    const expenses = await this.prisma.expense.findMany({
      where: { tripId, deletedAt: null },
      include: { splits: true },
    });

    const members = await this.prisma.tripMember.findMany({
      where: { tripId },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });

    const balances: Record<string, Decimal> = {};
    members.forEach((m) => {
      balances[m.userId] = new Decimal(0);
    });

    for (const expense of expenses) {
      // payer gets credit
      balances[expense.paidById] = balances[expense.paidById].add(
        expense.amount,
      );
      // each splitter owes their share
      for (const split of expense.splits) {
        balances[split.userId] = balances[split.userId].sub(split.shareAmount);
      }
    }

    // Build settlement transactions (simplify debts)
    const debtors = members
      .filter((m) => balances[m.userId].lt(0))
      .map((m) => ({ ...m.user, balance: balances[m.userId] }))
      .sort((a, b) => a.balance.comparedTo(b.balance));

    const creditors = members
      .filter((m) => balances[m.userId].gt(0))
      .map((m) => ({ ...m.user, balance: balances[m.userId] }))
      .sort((a, b) => b.balance.comparedTo(a.balance));

    const settlements: Array<{ from: any; to: any; amount: Decimal }> = [];
    let i = 0,
      j = 0;
    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i];
      const creditor = creditors[j];
      const amount = Decimal.min(debtor.balance.abs(), creditor.balance);
      settlements.push({ from: debtor, to: creditor, amount });
      debtor.balance = debtor.balance.add(amount);
      creditor.balance = creditor.balance.sub(amount);
      if (debtor.balance.eq(0)) i++;
      if (creditor.balance.eq(0)) j++;
    }

    const result = {
      balances: Object.entries(balances).map(([userId, balance]) => {
        const member = members.find((m) => m.userId === userId);
        return { user: member?.user, balance: balance.toNumber() };
      }),
      settlements: settlements.map((s) => ({
        from: s.from,
        to: s.to,
        amount: s.amount.toNumber(),
      })),
    };

    try {
      await this.cacheManager.set(cacheKey, result, 300000);
    } catch (e) {
      console.error('Redis cache set error:', e.message);
    }

    return result;
  }

  async markSplitPaid(expenseId: string, userId: string, requesterId: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
    });
    if (!expense) throw new NotFoundException('Expense not found');

    // Only the person who paid for the expense can mark split bills as paid
    if (expense.paidById !== requesterId) {
      throw new ForbiddenException(
        'Only the expense payer can mark split bills as paid',
      );
    }

    const split = await this.prisma.expenseSplit.findUnique({
      where: { expenseId_userId: { expenseId, userId } },
    });
    if (!split) throw new NotFoundException('Split not found');

    const updatedSplit = await this.prisma.expenseSplit.update({
      where: { expenseId_userId: { expenseId, userId } },
      data: { isPaid: true, paidAt: new Date() },
    });

    await this.evictCache(expense.tripId);
    return updatedSplit;
  }

  async delete(expenseId: string, userId: string, tripId: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
      include: { trip: { select: { createdBy: true } } },
    });
    if (!expense || expense.deletedAt)
      throw new NotFoundException('Expense not found');

    // Only the expense creator/payer or the trip creator can delete the expense
    if (expense.paidById !== userId && expense.trip.createdBy !== userId) {
      throw new ForbiddenException('errors.auth.notOwner');
    }

    const updatedExpense = await this.prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });

    await this.evictCache(tripId);
    return updatedExpense;
  }

  private async evictCache(tripId: string) {
    try {
      await this.cacheManager.del(`trip:${tripId}:expenses`);
      await this.cacheManager.del(`trip:${tripId}:balances`);
    } catch (e) {
      console.error('Redis cache eviction error:', e.message);
    }
  }

  // --- EXTENSION FOR MODULE 7 (FINANCE FLOW) ---

  async getWallet(tripId: string, userId: string) {
    let wallet = await this.prisma.userWallet.findUnique({
      where: { userId },
    });
    if (!wallet) {
      wallet = await this.prisma.userWallet.create({
        data: { userId },
      });
    }
    const banks = await this.getLinkedBanks(userId);
    const cards = await this.getPaymentMethods(userId);
    return {
      userId,
      balanceMomo: Number(wallet.balanceMomo),
      balanceZalo: Number(wallet.balanceZalo),
      balanceCash: Number(wallet.balanceCash),
      linkedBanksCount: banks.length,
      creditCardsCount: cards.length,
      banks,
      cards,
    };
  }

  async getLinkedBanks(userId: string) {
    const banks = await this.prisma.linkedBank.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    // Seed default mock banks if user has none, to maintain initial premium features
    if (banks.length === 0) {
      const defaultBanks = [
        {
          bankName: 'Vietcombank',
          accountNumber: '******8901',
          accountHolder: 'NGUYEN VAN A',
          isVerified: true,
          logoUrl: 'assets/images/banks/vcb.png',
        },
        {
          bankName: 'Techcombank',
          accountNumber: '******3456',
          accountHolder: 'NGUYEN VAN A',
          isVerified: true,
          logoUrl: 'assets/images/banks/tcb.png',
        },
      ];

      const createdBanks = [];
      for (const bank of defaultBanks) {
        const cb = await this.prisma.linkedBank.create({
          data: { userId, ...bank },
        });
        createdBanks.push(cb);
      }
      return createdBanks;
    }

    return banks;
  }

  async linkBank(userId: string, data: any) {
    if (!data.bankName || !data.accountNumber || !data.accountHolder) {
      throw new BadRequestException('Missing bank account parameters');
    }

    const accountNumberMasked =
      data.accountNumber.length > 4
        ? `******${data.accountNumber.slice(-4)}`
        : data.accountNumber;

    const newBank = await this.prisma.linkedBank.create({
      data: {
        userId,
        bankName: data.bankName,
        accountNumber: accountNumberMasked,
        accountHolder: data.accountHolder.toUpperCase(),
        isVerified: true,
        logoUrl: 'assets/images/banks/generic.png',
      },
    });

    // Update linkedBanksCount in wallet
    const banks = await this.prisma.linkedBank.findMany({ where: { userId } });
    await this.prisma.userWallet.upsert({
      where: { userId },
      create: { userId, linkedBanksCount: banks.length },
      update: { linkedBanksCount: banks.length },
    });

    return newBank;
  }

  async getPaymentMethods(userId: string) {
    const cards = await this.prisma.paymentCard.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    // Seed default mock card if none exist
    if (cards.length === 0) {
      const defaultCard = await this.prisma.paymentCard.create({
        data: {
          userId,
          type: 'VISA',
          lastFour: '4242',
          expiry: '12/28',
          cardHolder: 'NGUYEN VAN A',
          colorIndex: 0,
        },
      });
      return [defaultCard];
    }

    return cards;
  }

  async addPaymentMethod(
    userId: string,
    data: { cardNumber?: string; expiry?: string; cardHolder?: string },
  ) {
    if (!data.cardNumber || !data.expiry || !data.cardHolder) {
      throw new BadRequestException('Missing payment method parameters');
    }

    const lastFour =
      data.cardNumber.length > 4 ? data.cardNumber.slice(-4) : data.cardNumber;

    const type = data.cardNumber.startsWith('4') ? 'VISA' : 'MASTERCARD';

    const newCard = await this.prisma.paymentCard.create({
      data: {
        userId,
        type,
        lastFour,
        expiry: data.expiry,
        cardHolder: data.cardHolder.toUpperCase(),
        colorIndex: Math.floor(Math.random() * 4),
      },
    });

    // Update creditCardsCount in wallet
    const cards = await this.prisma.paymentCard.findMany({ where: { userId } });
    await this.prisma.userWallet.upsert({
      where: { userId },
      create: { userId, creditCardsCount: cards.length },
      update: { creditCardsCount: cards.length },
    });

    return newCard;
  }

  async scanReceipt(receiptUrl: string) {
    return this.aiService.scanReceiptImage(receiptUrl);
  }

  async getBudgetGoal(tripId: string) {
    let budget = await this.prisma.budgetGoal.findUnique({
      where: { tripId },
    });
    if (!budget) {
      // Create a default BudgetGoal in DB for the trip
      budget = await this.prisma.budgetGoal.create({
        data: {
          tripId,
          limitAmount: 15000000.0, // 15M VND
          warningPercentage: 80,
          categoryLimits: [
            { category: 'FOOD', amount: 4000000.0 },
            { category: 'ACCOMMODATION', amount: 5000000.0 },
            { category: 'TRANSPORT', amount: 3000000.0 },
            { category: 'ACTIVITIES', amount: 2000000.0 },
            { category: 'OTHER', amount: 1000000.0 },
          ],
        },
      });
    }
    return {
      tripId,
      limitAmount: Number(budget.limitAmount),
      warningPercentage: budget.warningPercentage,
      categoryLimits: budget.categoryLimits,
    };
  }

  async updateBudgetGoal(tripId: string, data: any) {
    const current = await this.getBudgetGoal(tripId);

    const updated = await this.prisma.budgetGoal.upsert({
      where: { tripId },
      create: {
        tripId,
        limitAmount: data.limitAmount ?? current.limitAmount,
        warningPercentage: data.warningPercentage ?? current.warningPercentage,
        categoryLimits: data.categoryLimits ?? current.categoryLimits,
      },
      update: {
        limitAmount: data.limitAmount ?? current.limitAmount,
        warningPercentage: data.warningPercentage ?? current.warningPercentage,
        categoryLimits: data.categoryLimits ?? current.categoryLimits,
      },
    });

    return {
      tripId,
      limitAmount: Number(updated.limitAmount),
      warningPercentage: updated.warningPercentage,
      categoryLimits: updated.categoryLimits,
    };
  }

  async getSplitterGame(tripId: string) {
    // Generate a funny status for our spin-the-wheel squad picker
    const participants = [
      {
        name: 'Alex Nguyễn',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex',
      },
      {
        name: 'Trần Bình',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Binh',
      },
      {
        name: 'Lê Minh',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Minh',
      },
      {
        name: 'Hoàng Yến',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Yen',
      },
    ];
    const randomIndex = Math.floor(Math.random() * participants.length);
    return {
      tripId,
      gameType: 'SPIN_WHEEL',
      participants,
      selectedWinner: participants[randomIndex],
      roastMessage: `${participants[randomIndex].name} đã bị thần tài gõ đầu! Chuẩn bị thanh toán nha cưng! 💸💥`,
    };
  }
}
