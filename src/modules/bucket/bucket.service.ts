import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBucketItemDto } from './dto/create-bucket-item.dto';
import { UpdateBucketItemDto } from './dto/update-bucket-item.dto';

@Injectable()
export class BucketService {
  constructor(private readonly prisma: PrismaService) {}

  getList(userId: string) {
    return this.prisma.bucketItem.findMany({
      where: { userId },
      orderBy: [{ isCompleted: 'asc' }, { createdAt: 'desc' }],
    });
  }

  addItem(userId: string, dto: CreateBucketItemDto) {
    return this.prisma.bucketItem.create({
      data: { userId, title: dto.title.trim() },
    });
  }

  async updateItem(userId: string, itemId: string, dto: UpdateBucketItemDto) {
    const item = await this.prisma.bucketItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (item.userId !== userId) throw new ForbiddenException('Not authorized');

    return this.prisma.bucketItem.update({
      where: { id: itemId },
      data: {
        title: dto.title?.trim() ?? undefined,
        isCompleted: dto.isCompleted ?? undefined,
        completedAt:
          dto.isCompleted === undefined
            ? undefined
            : dto.isCompleted
              ? new Date()
              : null,
      },
    });
  }

  async deleteItem(userId: string, itemId: string) {
    const item = await this.prisma.bucketItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (item.userId !== userId) throw new ForbiddenException('Not authorized');

    await this.prisma.bucketItem.delete({ where: { id: itemId } });
    return { message: 'Item deleted' };
  }
}
