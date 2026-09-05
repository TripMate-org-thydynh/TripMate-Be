import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findSticker } from '../xp/store.catalog';
import { StoreService } from '../xp/store.service';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private store: StoreService,
  ) {}

  async sendMessage(
    tripId: string,
    senderId: string,
    data: {
      content?: string;
      mediaUrl?: string;
      type?: MessageType;
      replyToId?: string;
    },
  ) {
    // Gửi sticker phải sở hữu sticker đó. Không kiểm thì ai cũng gửi được mọi
    // sticker và việc đổi XP mua sticker trở nên vô nghĩa.
    if (data.type === 'STICKER') {
      const stickerId = data.content?.trim();
      if (!stickerId) {
        throw new BadRequestException('errors.store.stickerRequired');
      }
      if (!findSticker(stickerId)) {
        throw new NotFoundException('errors.store.stickerNotFound');
      }
      const owns = await this.store.ownsSticker(senderId, stickerId);
      if (!owns) {
        throw new ForbiddenException('errors.store.stickerNotOwned');
      }
    }

    return this.prisma.chatMessage.create({
      data: {
        tripId,
        senderId,
        content: data.content,
        mediaUrl: data.mediaUrl,
        type: data.type ?? 'TEXT',
        replyToId: data.replyToId,
      },
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: { select: { id: true, name: true } },
          },
        },
        reactions: { include: { user: { select: { id: true, name: true } } } },
      },
    });
  }

  async getMessages(tripId: string, cursor?: string, limit = 30) {
    return this.prisma.chatMessage.findMany({
      where: { tripId, deletedAt: null },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
        _count: { select: { replies: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleReaction(messageId: string, userId: string, emoji: string) {
    const existing = await this.prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    if (existing) {
      await this.prisma.messageReaction.delete({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
      });
      return { action: 'removed', emoji };
    }
    await this.prisma.messageReaction.create({
      data: { messageId, userId, emoji },
    });
    return { action: 'added', emoji };
  }

  async deleteMessage(id: string, userId: string) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id },
      include: { trip: { select: { createdBy: true } } },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== userId && message.trip.createdBy !== userId) {
      throw new ForbiddenException("You cannot delete someone else's message");
    }

    return this.prisma.chatMessage.update({
      where: { id },
      data: { deletedAt: new Date(), content: null },
    });
  }

  async searchMessages(tripId: string, query: string) {
    return this.prisma.chatMessage.findMany({
      where: {
        tripId,
        deletedAt: null,
        content: {
          contains: query,
          mode: 'insensitive',
        },
      },
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        reactions: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
