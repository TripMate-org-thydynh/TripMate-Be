import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFundDto } from './dto/create-fund.dto';
import { AddContributionDto } from './dto/add-contribution.dto';

@Injectable()
export class FundService {
  private readonly logger = new Logger(FundService.name);

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

    // Đảm bảo tính idempotent: đóng góp quỹ liên quan đến tiền bạc,
    // nếu client retry do mạng chập chờn, timeout hoặc double-tap thì không được phép cộng đôi.
    if (dto.clientRequestId) {
      const existing = await this.prisma.fundContribution.findUnique({
        where: { clientRequestId: dto.clientRequestId },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
        },
      });

      if (existing) {
        this.logger.log(
          `Idempotent replay: Khoản đóng góp với clientRequestId=${dto.clientRequestId} đã tồn tại, trả về bản ghi cũ`,
        );
        return existing;
      }
    }

    try {
      return await this.prisma.fundContribution.create({
        data: {
          fundId: fund.id,
          userId,
          amount: dto.amount,
          note: dto.note,
          status: 'CONFIRMED',
          clientRequestId: dto.clientRequestId,
        },
        include: {
          user: { select: { id: true, name: true, avatarUrl: true } },
        },
      });
    } catch (e) {
      // Bắt lỗi P2002 (unique constraint violation) trên clientRequestId:
      // nếu hai request song song cùng khoá cùng lọt qua bước kiểm tra ở trên,
      // một cái sẽ dính unique. Đọc lại bản ghi đã tồn tại và trả về cho client.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        dto.clientRequestId
      ) {
        this.logger.log(
          `P2002 race condition: Khoản đóng góp với clientRequestId=${dto.clientRequestId} đã được tạo bởi request song song, trả về bản ghi cũ`,
        );
        const existing = await this.prisma.fundContribution.findUnique({
          where: { clientRequestId: dto.clientRequestId },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        });
        if (existing) {
          return existing;
        }
      }
      throw e;
    }
  }

  async deleteContribution(
    contributionId: string,
    userId: string,
    tripId?: string,
  ) {
    const contribution = await this.prisma.fundContribution.findUnique({
      where: { id: contributionId },
      include: {
        fund: {
          include: {
            trip: {
              select: { id: true, createdBy: true },
            },
          },
        },
      },
    });
    if (!contribution) throw new NotFoundException('Contribution not found');

    if (tripId && contribution.fund?.tripId !== tripId) {
      throw new ForbiddenException(
        'Contribution does not belong to this trip',
      );
    }

    const isContributor = contribution.userId === userId;
    const isTripCreator = contribution.fund?.trip?.createdBy === userId;

    if (!isContributor && !isTripCreator) {
      throw new ForbiddenException(
        'You do not have permission to delete this contribution',
      );
    }

    await this.prisma.fundContribution.delete({
      where: { id: contributionId },
    });
    return { message: 'Contribution deleted' };
  }
}
