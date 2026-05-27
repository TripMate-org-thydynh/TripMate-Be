import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  // Mock in-memory store for budget goals & wallets
  private budgetGoals: Record<string, any> = {};
  private wallets: Record<string, any> = {};
  private bankAccounts: Record<string, any[]> = {};
  private cardMethods: Record<string, any[]> = {};

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

    return this.prisma.expense.create({
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
  }

  async findAll(tripId: string) {
    return this.prisma.expense.findMany({
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
  }

  async getBalances(tripId: string) {
    // Calculate net balances: positive = owed to user, negative = user owes
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

    return {
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
  }

  async markSplitPaid(expenseId: string, userId: string) {
    const split = await this.prisma.expenseSplit.findUnique({
      where: { expenseId_userId: { expenseId, userId } },
    });
    if (!split) throw new NotFoundException('Split not found');
    return this.prisma.expenseSplit.update({
      where: { expenseId_userId: { expenseId, userId } },
      data: { isPaid: true, paidAt: new Date() },
    });
  }

  async delete(expenseId: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
  }

  // --- EXTENSION FOR MODULE 7 (FINANCE FLOW) ---

  async getWallet(tripId: string, userId: string) {
    if (!this.wallets[userId]) {
      this.wallets[userId] = {
        userId,
        balanceMomo: 2500000.0,
        balanceZalo: 1200000.0,
        balanceCash: 500000.0,
        linkedBanksCount: 2,
        creditCardsCount: 1,
      };
    }
    const banks = await this.getLinkedBanks(userId);
    const cards = await this.getPaymentMethods(userId);
    return {
      ...this.wallets[userId],
      banks,
      cards,
    };
  }

  async getLinkedBanks(userId: string) {
    if (!this.bankAccounts[userId]) {
      this.bankAccounts[userId] = [
        {
          id: 'bank-1',
          bankName: 'Vietcombank',
          accountNumber: '******8901',
          accountHolder: 'NGUYEN VAN A',
          isVerified: true,
          logoUrl: 'assets/images/banks/vcb.png',
        },
        {
          id: 'bank-2',
          bankName: 'Techcombank',
          accountNumber: '******3456',
          accountHolder: 'NGUYEN VAN A',
          isVerified: true,
          logoUrl: 'assets/images/banks/tcb.png',
        },
      ];
    }
    return this.bankAccounts[userId];
  }

  async linkBank(userId: string, data: any) {
    if (!data.bankName || !data.accountNumber || !data.accountHolder) {
      throw new BadRequestException('Missing bank account parameters');
    }
    const newBank = {
      id: `bank-${Date.now()}`,
      bankName: data.bankName,
      accountNumber: `******${data.accountNumber.slice(-4)}`,
      accountHolder: data.accountHolder.toUpperCase(),
      isVerified: true,
      logoUrl: 'assets/images/banks/generic.png',
    };
    if (!this.bankAccounts[userId]) {
      this.bankAccounts[userId] = [];
    }
    this.bankAccounts[userId].push(newBank);
    return newBank;
  }

  async getPaymentMethods(userId: string) {
    if (!this.cardMethods[userId]) {
      this.cardMethods[userId] = [
        {
          id: 'card-1',
          type: 'VISA',
          lastFour: '4242',
          expiry: '12/28',
          cardHolder: 'NGUYEN VAN A',
          colorIndex: 0,
        },
      ];
    }
    return this.cardMethods[userId];
  }

  async addPaymentMethod(userId: string, data: any) {
    if (!data.cardNumber || !data.expiry || !data.cardHolder || !data.cvv) {
      throw new BadRequestException('Missing payment method parameters');
    }
    const newCard = {
      id: `card-${Date.now()}`,
      type: data.cardNumber.startsWith('4') ? 'VISA' : 'MASTERCARD',
      lastFour: data.cardNumber.slice(-4),
      expiry: data.expiry,
      cardHolder: data.cardHolder.toUpperCase(),
      colorIndex: Math.floor(Math.random() * 4),
    };
    if (!this.cardMethods[userId]) {
      this.cardMethods[userId] = [];
    }
    this.cardMethods[userId].push(newCard);
    return newCard;
  }

  async scanReceipt(receiptUrl: string) {
    // Return a mocked mock parse result of a Kyoto or Dalat restaurant
    return {
      success: true,
      merchant: 'Lẩu gà lá é Tao Ngộ',
      date: new Date().toLocaleDateString('vi-VN'),
      items: [
        { name: 'Lẩu gà lá é lớn', quantity: 1, price: 350000.0, selected: true },
        { name: 'Nước ngọt lon', quantity: 4, price: 60000.0, selected: true },
        { name: 'Mì gói thêm', quantity: 2, price: 20000.0, selected: true },
        { name: 'Khăn lạnh', quantity: 4, price: 10000.0, selected: false },
      ],
      subtotal: 440000.0,
      tax: 44000.0,
      total: 484000.0,
      confidenceScore: 0.96,
      suggestedCategory: 'FOOD',
    };
  }

  async getBudgetGoal(tripId: string) {
    if (!this.budgetGoals[tripId]) {
      this.budgetGoals[tripId] = {
        tripId,
        limitAmount: 15000000.0, // 15M VND
        warningPercentage: 80, // Warn at 80%
        categoryLimits: [
          { category: 'FOOD', amount: 4000000.0 },
          { category: 'ACCOMMODATION', amount: 5000000.0 },
          { category: 'TRANSPORT', amount: 3000000.0 },
          { category: 'ACTIVITIES', amount: 2000000.0 },
          { category: 'OTHER', amount: 1000000.0 },
        ],
      };
    }
    return this.budgetGoals[tripId];
  }

  async updateBudgetGoal(tripId: string, data: any) {
    const current = await this.getBudgetGoal(tripId);
    this.budgetGoals[tripId] = {
      ...current,
      limitAmount: data.limitAmount ?? current.limitAmount,
      warningPercentage: data.warningPercentage ?? current.warningPercentage,
      categoryLimits: data.categoryLimits ?? current.categoryLimits,
    };
    return this.budgetGoals[tripId];
  }

  async getSplitterGame(tripId: string) {
    // Generate a funny status for our spin-the-wheel squad picker
    const participants = [
      { name: 'Alex Nguyễn', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex' },
      { name: 'Trần Bình', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Binh' },
      { name: 'Lê Minh', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Minh' },
      { name: 'Hoàng Yến', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Yen' },
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
