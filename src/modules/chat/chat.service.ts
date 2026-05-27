import { Injectable } from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

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
