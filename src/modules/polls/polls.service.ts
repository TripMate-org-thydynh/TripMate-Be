import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';

@Injectable()
export class PollsService {
  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

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
    const row = await this.prisma.poll.create({
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
    // Ghi nhật ký hoạt động để feed squad có dữ liệu — trước đây
    // ActivitiesService.log() không được gọi ở bất kỳ đâu.
    await this.activities.log(
      tripId,
      createdBy,
      'POLL_CREATED',
      { question: row.question },
      row.id,
    );
    return row;
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
    const option = await this.prisma.pollOption.findUnique({
      where: { id: optionId },
      select: {
        pollId: true,
        poll: { select: { closesAt: true, isMultiple: true } },
      },
    });
    if (!option) throw new NotFoundException('errors.database.notFound');
    if (option.poll.closesAt && option.poll.closesAt.getTime() < Date.now()) {
      throw new BadRequestException('Bình chọn này đã đóng');
    }

    const existing = await this.prisma.pollVote.findUnique({
      where: { optionId_userId: { optionId, userId } },
    });
    if (existing) {
      await this.prisma.pollVote.delete({
        where: { optionId_userId: { optionId, userId } },
      });
      return { action: 'unvoted' };
    }

    // Bình chọn một lựa chọn: bỏ phiếu mới thay cho phiếu cũ, không cộng dồn.
    await this.prisma.$transaction([
      ...(option.poll.isMultiple
        ? []
        : [
            this.prisma.pollVote.deleteMany({
              where: { userId, option: { pollId: option.pollId } },
            }),
          ]),
      this.prisma.pollVote.create({ data: { optionId, userId } }),
    ]);
    return { action: 'voted' };
  }
}
