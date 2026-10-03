import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { findSticker } from '../xp/store.catalog';
import {
  CUSTOM_STICKER_PREFIX,
  CustomStickerService,
} from '../xp/custom-sticker.service';
import { StoreService } from '../xp/store.service';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private store: StoreService,
    private customStickers: CustomStickerService,
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
    let mediaUrl = data.mediaUrl;
    if (data.type === 'STICKER') {
      const stickerId = data.content?.trim();
      if (!stickerId) {
        throw new BadRequestException('errors.store.stickerRequired');
      }
      // Ảnh của tin sticker do SERVER quyết định, không lấy từ client: sticker
      // cá nhân lấy đúng ảnh của sticker đó, sticker emoji thì không có ảnh.
      mediaUrl = undefined;
      if (stickerId.startsWith(CUSTOM_STICKER_PREFIX)) {
        mediaUrl = await this.customStickers.resolveForSend(
          senderId,
          stickerId,
        );
      } else if (!findSticker(stickerId)) {
        throw new NotFoundException('errors.store.stickerNotFound');
      } else {
        const owns = await this.store.ownsSticker(senderId, stickerId);
        if (!owns) {
          throw new ForbiddenException('errors.store.stickerNotOwned');
        }
      }
    }

    return this.prisma.chatMessage.create({
      data: {
        tripId,
        senderId,
        content: data.content,
        mediaUrl,
        type: data.type ?? 'TEXT',
        replyToId: data.replyToId,
      },
      // Chỉ lấy thứ tin MỚI thật sự có. Mỗi `include` là một lượt truy vấn nữa
      // tới database ở xa: tin vừa tạo chưa thể có reaction, và chỉ cần đọc tin
      // được trả lời khi có trả lời.
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        ...(data.replyToId
          ? {
              replyTo: {
                select: {
                  id: true,
                  content: true,
                  sender: { select: { id: true, name: true } },
                },
              },
            }
          : {}),
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
      // `contains` không dùng được index: giới hạn kết quả để một từ khoá
      // phổ biến ("ok") không kéo cả lịch sử chat của chuyến về.
      take: 50,
    });
  }
}
