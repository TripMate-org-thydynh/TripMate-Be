import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PollsService {
  constructor(private prisma: PrismaService) {}

  async create(
    tripId: string,
    createdBy: string,
    data: {
      question: string;
      options: string[];
      isMultiple?: boolean;
      closesAt?: string;
    },
  ) {
    return this.prisma.poll.create({
      data: {
        tripId,
        createdBy,
        question: data.question,
        isMultiple: data.isMultiple ?? false,
        closesAt: data.closesAt ? new Date(data.closesAt) : undefined,
        options: {
          create: data.options.map((text) => ({ text })),
        },
      },
      include: {
        options: { include: { _count: { select: { votes: true } } } },
      },
    });
  }

  async findAll(tripId: string) {
    return this.prisma.poll.findMany({
      where: { tripId },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
        options: { include: { _count: { select: { votes: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async vote(optionId: string, userId: string) {
    // Check if already voted
    const existing = await this.prisma.pollVote.findUnique({
      where: { optionId_userId: { optionId, userId } },
    });
    if (existing) {
      await this.prisma.pollVote.delete({
        where: { optionId_userId: { optionId, userId } },
      });
      return { action: 'unvoted' };
    }
    await this.prisma.pollVote.create({ data: { optionId, userId } });
    return { action: 'voted' };
  }
}
