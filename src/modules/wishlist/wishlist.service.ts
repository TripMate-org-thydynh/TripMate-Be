import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWishlistItemDto } from './dto/create-wishlist-item.dto';

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  async getWishlist(tripId: string, type?: 'FOOD' | 'PLACE') {
    return this.prisma.wishlistItem.findMany({
      where: { tripId, ...(type ? { type } : {}) },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        votes: { select: { userId: true } },
      },
      orderBy: { voteCount: 'desc' },
    });
  }

  async addItem(tripId: string, userId: string, dto: CreateWishlistItemDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    return this.prisma.wishlistItem.create({
      data: {
        tripId,
        addedBy: userId,
        type: dto.type,
        name: dto.name,
        address: dto.address,
        link: dto.link,
        notes: dto.notes,
      },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        votes: { select: { userId: true } },
      },
    });
  }

  async toggleVote(itemId: string, userId: string) {
    const item = await this.prisma.wishlistItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');

    const existingVote = await this.prisma.wishlistVote.findUnique({
      where: { itemId_userId: { itemId, userId } },
    });

    if (existingVote) {
      // Unvote
      await this.prisma.wishlistVote.delete({
        where: { itemId_userId: { itemId, userId } },
      });
      await this.prisma.wishlistItem.update({
        where: { id: itemId },
        data: { voteCount: { decrement: 1 } },
      });
      return { voted: false };
    } else {
      // Vote
      await this.prisma.wishlistVote.create({ data: { itemId, userId } });
      await this.prisma.wishlistItem.update({
        where: { id: itemId },
        data: { voteCount: { increment: 1 } },
      });
      return { voted: true };
    }
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async deleteItem(itemId: string, userId: string) {
    const item = await this.prisma.wishlistItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('errors.database.notFound');

    await this.prisma.wishlistItem.delete({ where: { id: itemId } });
    return { message: 'Item deleted' };
  }
}
