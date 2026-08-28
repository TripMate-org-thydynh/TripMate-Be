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
  ) {}

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

  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { tripId: string },
  ) {
    if (!body?.tripId) return;
    void client.join(`trip:${body.tripId}`);
    client.emit('joined', { tripId: body.tripId });
  }

  @SubscribeMessage('leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { tripId: string },
  ) {
    if (!body?.tripId) return;
    void client.leave(`trip:${body.tripId}`);
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { tripId: string; content?: string; mediaUrl?: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.tripId) return;

    const saved = await this.chatService.sendMessage(body.tripId, userId, {
      content: body.content,
      mediaUrl: body.mediaUrl,
    });

    // Broadcast cho mọi người trong room (gồm cả người gửi để đồng bộ).
    this.server.to(`trip:${body.tripId}`).emit('message', saved);
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
