import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { GoogleAuth } from 'google-auth-library';

/** Kết quả xác minh. `reason` để ghi log và đọc báo cáo, không trả cho client. */
export interface IntegrityResult {
  verified: boolean;
  reason: string;
}

/** Phần payload Google trả về mà ta dùng (tokenPayloadExternal). */
export interface IntegrityPayload {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    timestampMillis?: string | number;
  };
  appIntegrity?: { appRecognitionVerdict?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

/**
 * Xác minh token Play Integrity mà app gửi kèm khi xin dùng thử.
 *
 * Vấn đề nó giải: `deviceId` do client tự khai, nên server không tin được và
 * phải dựa vào dải mạng — thứ chặn oan người dùng 4G chung IP nhà mạng. Có
 * token hợp lệ thì Google bảo đảm request đến từ đúng app này, cài từ Play,
 * trên một máy thật; khi đó mã thiết bị (Android ID) đáng tin và luật theo
 * dải mạng không cần nữa.
 *
 * Token gắn với mã thiết bị qua `requestHash = sha256("trial:" + deviceId)`:
 * lấy token của máy này ghép với mã của máy khác thì không khớp. Dùng lại
 * token với chính mã đó thì vô hại — nó chỉ cộng thêm vào hạn mức của chính
 * máy đó.
 *
 * Mọi lỗi (chưa cấu hình, Google lỗi, mạng chậm) đều ra `verified: false`, và
 * khi đó tầng xét duyệt quay về luật cũ. Không bao giờ để lỗi ở đây làm hỏng
 * request xin dùng thử.
 */
@Injectable()
export class PlayIntegrityService {
  private readonly logger = new Logger(PlayIntegrityService.name);
  private auth: GoogleAuth | null | undefined;

  /** Token cũ hơn mức này thì coi như phát lại. */
  static readonly MAX_AGE_MS = 10 * 60 * 1000;

  static packageName(): string {
    return process.env.PLAY_INTEGRITY_PACKAGE || 'com.tripmate.app';
  }

  static requestHashFor(deviceId: string): string {
    return createHash('sha256').update(`trial:${deviceId}`).digest('hex');
  }

  async verify(
    token: string | undefined,
    deviceId: string | undefined,
  ): Promise<IntegrityResult> {
    if (!token || !deviceId) return { verified: false, reason: 'NO_TOKEN' };
    if (!this.client()) return { verified: false, reason: 'NOT_CONFIGURED' };

    let payload: IntegrityPayload;
    try {
      payload = await this.decode(token);
    } catch (err) {
      this.logger.warn(
        `Không giải mã được token Play Integrity: ${(err as Error).message}`,
      );
      return { verified: false, reason: 'DECODE_FAILED' };
    }
    return PlayIntegrityService.judge(payload, {
      packageName: PlayIntegrityService.packageName(),
      requestHash: PlayIntegrityService.requestHashFor(deviceId),
      now: Date.now(),
    });
  }

  /**
   * Phán quyết thuần trên payload đã giải mã — tách riêng để test được mà
   * không cần Google.
   */
  static judge(
    payload: IntegrityPayload,
    expect: { packageName: string; requestHash: string; now: number },
  ): IntegrityResult {
    const req = payload.requestDetails ?? {};
    if (req.requestPackageName !== expect.packageName) {
      return { verified: false, reason: 'WRONG_PACKAGE' };
    }
    if (req.requestHash !== expect.requestHash) {
      return { verified: false, reason: 'HASH_MISMATCH' };
    }
    const ts = Number(req.timestampMillis);
    if (!Number.isFinite(ts) || Math.abs(expect.now - ts) > this.MAX_AGE_MS) {
      return { verified: false, reason: 'STALE_TOKEN' };
    }
    if (payload.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
      return { verified: false, reason: 'APP_NOT_RECOGNIZED' };
    }
    // MEETS_DEVICE_INTEGRITY: máy Android thật có Play. Máy ảo và máy đã root
    // chỉ có BASIC hoặc không có gì — đúng nhóm dùng để tạo tài khoản hàng loạt.
    const device = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    if (!device.includes('MEETS_DEVICE_INTEGRITY')) {
      return { verified: false, reason: 'DEVICE_NOT_TRUSTED' };
    }
    return { verified: true, reason: 'OK' };
  }

  /** Gọi Google giải mã token. `protected` để test thay được. */
  protected async decode(token: string): Promise<IntegrityPayload> {
    const client = this.client();
    if (!client) throw new Error('NOT_CONFIGURED');
    const pkg = encodeURIComponent(PlayIntegrityService.packageName());
    const res = await client.request<{
      tokenPayloadExternal?: IntegrityPayload;
    }>({
      url: `https://playintegrity.googleapis.com/v1/${pkg}:decodeIntegrityToken`,
      method: 'POST',
      data: { integrity_token: token },
      timeout: 5000,
    });
    return res.data.tokenPayloadExternal ?? {};
  }

  /**
   * Khoá service account đặt ở `PLAY_INTEGRITY_SA_KEY`: JSON nguyên văn hoặc
   * base64 của JSON (dán vào biến môi trường dễ hơn). Thiếu thì tính năng tắt.
   */
  private client(): GoogleAuth | null {
    if (this.auth !== undefined) return this.auth;
    const raw = process.env.PLAY_INTEGRITY_SA_KEY?.trim();
    if (!raw) {
      this.auth = null;
      return null;
    }
    try {
      const json = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      this.auth = new GoogleAuth({
        credentials: JSON.parse(json),
        scopes: ['https://www.googleapis.com/auth/playintegrity'],
      });
    } catch {
      this.logger.error('PLAY_INTEGRITY_SA_KEY không phải JSON hợp lệ');
      this.auth = null;
    }
    return this.auth;
  }
}
