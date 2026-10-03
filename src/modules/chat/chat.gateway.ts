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
    // Xác thực có truy vấn DB nên bất đồng bộ; client thường phát `join` ngay
    // sau khi nối. Các handler chờ promise này để không xử lý sự kiện khi
    // `userId` chưa kịp gắn.
    client.data.ready = this.authenticate(client);
  }

  private async authenticate(client: Socket): Promise<void> {
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
      const payload = this.jwtService.verify<{
        sub?: string;
        purpose?: string;
      }>(token);
      // Cùng luật với JwtStrategy: chỉ token đăng nhập, user còn tồn tại và
      // không bị khoá.
      if (payload.purpose || typeof payload.sub !== 'string') {
        client.disconnect();
        return;
      }
      const user = await this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null, isLocked: false },
        select: { id: true },
      });
      if (!user) {
        client.disconnect();
        return;
      }
      client.data.userId = user.id;
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
    await client.data.ready;
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
    await client.data.ready;
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.tripId) return;
    if (!this.joinedTrips(client).has(body.tripId)) {
      client.emit('message_error', {
        clientId: body.clientId,
        reason: 'NOT_JOINED',
      });
      return;
    }
    // Kiểm lại tư cách thành viên mỗi tin: socket sống lâu hơn tư cách thành
    // viên, người đã bị mời ra không được tiếp tục gửi/nghe trong phòng.
    if (!(await this.stillMember(client, body.tripId, userId))) {
      client.emit('message_error', {
        clientId: body.clientId,
        reason: 'NOT_MEMBER',
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
    const userId = client.data.userId as string | undefined;
    if (!userId || typeof body?.tripId !== 'string') return;
    // Chỉ socket đã join (đã qua kiểm thành viên) mới phát được vào phòng.
    if (!this.joinedTrips(client).has(body.tripId)) return;
    client.to(`trip:${body.tripId}`).emit('typing', {
      userId,
      isTyping: body.isTyping === true,
    });
  }

  /// Còn là thành viên không; nếu không thì đẩy socket ra khỏi phòng luôn.
  private async stillMember(
    client: Socket,
    tripId: string,
    userId: string,
  ): Promise<boolean> {
    const member = await this.prisma.tripMember.findFirst({
      where: { tripId, userId, trip: { deletedAt: null } },
      select: { tripId: true },
    });
    if (member) return true;
    this.joinedTrips(client).delete(tripId);
    void client.leave(`trip:${tripId}`);
    return false;
  }
}
