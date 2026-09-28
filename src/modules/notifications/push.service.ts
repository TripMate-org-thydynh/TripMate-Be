import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';

export interface PushMessage {
  title: string;
  body: string;
  /** FCM chỉ nhận chuỗi: mọi giá trị được ép sang string trước khi gửi. */
  data?: Record<string, unknown>;
}

export interface PushResult {
  /** false = chưa cấu hình Firebase, không có gì được gửi đi. */
  enabled: boolean;
  /** Số máy đã thử gửi. */
  attempted: number;
  /** Số máy FCM xác nhận đã nhận. */
  delivered: number;
}

/** Mã lỗi nghĩa là token đã chết: gỡ khỏi DB để lần sau khỏi gửi vô ích. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** FCM giới hạn 500 token mỗi lần gửi. */
const FCM_BATCH = 500;

/**
 * Gửi thông báo đẩy qua FCM để đánh thức điện thoại khi app đang đóng.
 *
 * Chưa có khoá service account thì dịch vụ **ngủ**: không ném lỗi, không
 * giả vờ đã gửi — trả `enabled: false` để nơi gọi biết thật. Bản cũ chỉ ghi
 * log "[FCM Push] Sent" rồi trả `success: true` dù chẳng gửi đi đâu.
 *
 * Khoá lấy từ một trong hai biến môi trường:
 * - `FIREBASE_SERVICE_ACCOUNT_PATH`: đường dẫn tới file JSON (chạy máy).
 * - `FIREBASE_SERVICE_ACCOUNT_JSON`: nguyên nội dung JSON (Render, không
 *   gắn được file).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private messaging: Messaging | null | undefined;

  constructor(private readonly prisma: PrismaService) {}

  get enabled(): boolean {
    return this.client() !== null;
  }

  /** Khởi tạo lười, đúng một lần. `null` = chưa cấu hình. */
  private client(): Messaging | null {
    if (this.messaging !== undefined) return this.messaging;
    const raw = this.readCredentials();
    if (!raw) {
      this.logger.warn(
        'Chưa cấu hình Firebase — thông báo đẩy đang TẮT. Thông báo vẫn lưu ' +
          'trong app, chỉ là không đánh thức được điện thoại.',
      );
      this.messaging = null;
      return null;
    }
    try {
      const app: App =
        getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(raw)) });
      this.messaging = getMessaging(app);
      this.logger.log('Firebase đã bật — thông báo đẩy hoạt động.');
    } catch (e) {
      // Khoá hỏng thì tắt hẳn chứ không làm sập cả server.
      this.logger.error(`Khoá Firebase không dùng được: ${(e as Error).message}`);
      this.messaging = null;
    }
    return this.messaging;
  }

  private readCredentials(): string | null {
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (inline) return inline;
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
    if (!path) return null;
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      this.logger.error(
        `Không đọc được FIREBASE_SERVICE_ACCOUNT_PATH: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Ghi token của một máy. Token đã thuộc người khác thì đổi chủ: đăng xuất
   * rồi đăng nhập tài khoản khác trên cùng máy, thông báo phải theo người
   * đang dùng máy chứ không theo người cũ.
   */
  async registerToken(userId: string, token: string, platform = 'android') {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  /** Chỉ gỡ token của chính mình, không gỡ được token máy người khác. */
  async removeToken(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  async sendToUsers(userIds: string[], msg: PushMessage): Promise<PushResult> {
    const messaging = this.client();
    if (!messaging || userIds.length === 0) {
      return { enabled: messaging !== null, attempted: 0, delivered: 0 };
    }

    const rows = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    const tokens = rows.map((r) => r.token);
    if (tokens.length === 0) {
      return { enabled: true, attempted: 0, delivered: 0 };
    }

    const data = Object.fromEntries(
      Object.entries(msg.data ?? {}).map(([k, v]) => [k, String(v)]),
    );
    let delivered = 0;
    const dead: string[] = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH) {
      const batch = tokens.slice(i, i + FCM_BATCH);
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title: msg.title, body: msg.body },
        data,
        android: { priority: 'high' },
      });
      delivered += res.successCount;
      res.responses.forEach((r, j) => {
        if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) {
          dead.push(batch[j]);
        }
      });
    }

    if (dead.length) {
      await this.prisma.deviceToken.deleteMany({
        where: { token: { in: dead } },
      });
      this.logger.log(`Gỡ ${dead.length} token đã chết`);
    }
    return { enabled: true, attempted: tokens.length, delivered };
  }
}
