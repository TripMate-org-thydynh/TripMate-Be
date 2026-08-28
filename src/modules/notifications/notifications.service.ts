import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    userId: string;
    tripId?: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: object;
  }) {
    return this.prisma.notification.create({ data });
  }

  async findAll(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to access this notification',
      );
    }
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  /**
   * Giả lập / Dispatch FCM Push Notification tới thiết bị di động
   */
  async sendPushNotification(payload: {
    userId: string;
    title: string;
    body: string;
    type?: NotificationType;
    data?: Record<string, any>;
  }) {
    // 1) Lưu notification vào DB
    const notif = await this.create({
      userId: payload.userId,
      type: payload.type ?? 'TRIP_UPDATE',
      title: payload.title,
      body: payload.body,
      data: payload.data,
    });

    // 2) Log FCM Payload Dispatch
    console.log(`[FCM Push] Sent to user ${payload.userId}:`, {
      title: payload.title,
      body: payload.body,
      data: payload.data,
    });

    return { success: true, notification: notif };
  }

  /**
   * Báo thông báo cho toàn bộ thành viên trong Trip (trừ người gửi)
   */
  async notifyTripMembers(params: {
    tripId: string;
    senderId: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const members = await this.prisma.tripMember.findMany({
      where: { tripId: params.tripId, NOT: { userId: params.senderId } },
      select: { userId: true },
    });

    const notifications = await Promise.all(
      members.map((m) =>
        this.create({
          userId: m.userId,
          tripId: params.tripId,
          type: params.type,
          title: params.title,
          body: params.body,
          data: params.data,
        }),
      ),
    );

    return { notifiedCount: notifications.length };
  }
}
