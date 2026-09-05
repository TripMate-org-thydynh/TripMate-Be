import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFundDto } from './dto/create-fund.dto';
import { AddContributionDto } from './dto/add-contribution.dto';

@Injectable()
export class FundService {
  constructor(private readonly prisma: PrismaService) {}

  async createFund(tripId: string, userId: string, dto: CreateFundDto) {
    // Kiểm tra trip tồn tại
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    // Mỗi trip chỉ có 1 fund
    const existing = await this.prisma.tripFund.findUnique({
      where: { tripId },
    });
    if (existing) throw new ConflictException('Trip already has a fund');

    return this.prisma.tripFund.create({
      data: {
        tripId,
        targetAmount: dto.targetAmount,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
        note: dto.note,
      },
      include: {
        contributions: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async getFund(tripId: string) {
    const fund = await this.prisma.tripFund.findUnique({
      where: { tripId },
      include: {
        contributions: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!fund) throw new NotFoundException('Fund not found for this trip');

    const totalCollected = fund.contributions.reduce(
      (sum, c) => sum + Number(c.amount),
      0,
    );

    return {
      ...fund,
      totalCollected,
      progressPercent: Math.min(
        Math.round((totalCollected / Number(fund.targetAmount)) * 100),
        100,
      ),
    };
  }

  async addContribution(
    tripId: string,
    userId: string,
    dto: AddContributionDto,
  ) {
    const fund = await this.prisma.tripFund.findUnique({ where: { tripId } });
    if (!fund) throw new NotFoundException('Fund not found');

    return this.prisma.fundContribution.create({
      data: {
        fundId: fund.id,
        userId,
        amount: dto.amount,
        note: dto.note,
        status: 'CONFIRMED',
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async deleteContribution(contributionId: string, userId: string) {
    const contribution = await this.prisma.fundContribution.findUnique({
      where: { id: contributionId },
    });
    if (!contribution) throw new NotFoundException('Contribution not found');

    await this.prisma.fundContribution.delete({
      where: { id: contributionId },
    });
    return { message: 'Contribution deleted' };
  }
}
