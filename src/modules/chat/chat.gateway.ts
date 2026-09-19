import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Realtime chat gateway. Client kết nối kèm JWT trong handshake.auth.token,
 * join room theo trip, gửi/nhận tin nhắn realtime.
 *   socket = io(url, { auth: { token } })
 *   socket.emit('join', { tripId })
 *   socket.emit('message', { tripId, content })
 *   socket.on('message', (msg) => ...)
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /** Các chuyến socket này đã được xác nhận là thành viên (kiểm lúc join). */
  private joinedTrips(client: Socket): Set<string> {
    if (!(client.data.trips instanceof Set)) client.data.trips = new Set();
    return client.data.trips as Set<string>;
  }

  handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string)?.replace(
          'Bearer ',
          '',
        );
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify<{ sub: string }>(token);
      client.data.userId = payload.sub;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Vào phòng chat của một chuyến.
   *
   * PHẢI là thành viên chuyến (và chuyến chưa xoá). Trước đây `join` không kiểm
   * gì: ai đăng nhập cũng nghe lén được chat của mọi chuyến chỉ cần biết tripId,
   * và `message` cũng không kiểm nên gửi được tin vào chuyến người khác.
   */
  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { tripId: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || typeof body?.tripId !== 'string') return;
    const member = await this.prisma.tripMember.findFirst({
      where: { tripId: body.tripId, userId, trip: { deletedAt: null } },
      select: { tripId: true },
    });
    if (!member) {
      client.emit('join_error', { tripId: body.tripId, reason: 'NOT_MEMBER' });
      return;
    }
    this.joinedTrips(client).add(body.tripId);
    void client.join(`trip:${body.tripId}`);
    client.emit('joined', { tripId: body.tripId });
  }

  @SubscribeMessage('leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { tripId: string },
  ) {
    if (!body?.tripId) return;
    this.joinedTrips(client).delete(body.tripId);
    void client.leave(`trip:${body.tripId}`);
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      tripId: string;
      content?: string;
      mediaUrl?: string;
      clientId?: string;
    },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.tripId) return;
    // Thành viên đã được kiểm lúc join — không tốn thêm truy vấn mỗi tin.
    if (!this.joinedTrips(client).has(body.tripId)) {
      client.emit('message_error', {
        clientId: body.clientId,
        reason: 'NOT_JOINED',
      });
      return;
    }
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content && !body.mediaUrl) return;

    try {
      const saved = await this.chatService.sendMessage(body.tripId, userId, {
        content: content || undefined,
        mediaUrl: body.mediaUrl,
      });
      // Broadcast cho cả phòng, kèm clientId để máy gửi thay bản "đang gửi".
      const clientId =
        typeof body.clientId === 'string'
          ? body.clientId.slice(0, 64)
          : undefined;
      this.server
        .to(`trip:${body.tripId}`)
        .emit('message', { ...saved, clientId });
    } catch (e) {
      this.logger.warn(`Gui tin that bai: ${(e as Error).message}`);
      client.emit('message_error', {
        clientId: body.clientId,
        reason: 'SAVE_FAILED',
      });
    }
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { tripId: string; isTyping: boolean },
  ) {
    if (!body?.tripId) return;
    client.to(`trip:${body.tripId}`).emit('typing', {
      userId: client.data.userId as string,
      isTyping: body.isTyping,
    });
  }
}
