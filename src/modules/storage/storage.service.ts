import { createHash } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Loại file cho phép tải lên, kèm đuôi tương ứng. */
const ALLOWED: Record<
  string,
  { ext: string; kind: 'image' | 'video' | 'raw' }
> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/heic': { ext: 'heic', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'application/pdf': { ext: 'pdf', kind: 'raw' },
};

const MAX_BYTES: Record<'image' | 'video' | 'raw', number> = {
  image: 10 * 1024 * 1024, // 10 MB
  video: 60 * 1024 * 1024, // 60 MB
  raw: 20 * 1024 * 1024, // 20 MB
};

export interface UploadTicket {
  uploadUrl: string;
  /** Các trường phải gửi kèm trong form multipart. */
  fields: Record<string, string>;
  /** Đường dẫn logic (public_id) — client gửi lại khi tạo moment. */
  publicId: string;
  expiresAt: string;
}

/**
 * Cấp vé tải ảnh lên Cloudinary.
 *
 * App **không** giữ API secret. Backend ký sẵn một chữ ký sống ngắn rồi app
 * `POST` thẳng file lên Cloudinary — ảnh không đi qua RAM backend, và người
 * ngoài chuyến không xin được vé (đã chặn bằng `TripMemberGuard` ở controller).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private readonly cloudName?: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly folder: string;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    this.apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    this.apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    this.folder = this.config.get<string>('CLOUDINARY_FOLDER') ?? 'tripmate';

    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      this.logger.warn(
        'Thiếu cấu hình Cloudinary — mọi yêu cầu tải ảnh sẽ trả 503.',
      );
    }
  }

  get configured(): boolean {
    return Boolean(this.cloudName && this.apiKey && this.apiSecret);
  }

  /**
   * Chữ ký Cloudinary: sắp xếp tham số theo tên, nối `k=v` bằng `&`, thêm API
   * secret vào cuối rồi băm SHA-1. Đây là cách Cloudinary quy định.
   */
  private sign(params: Record<string, string>): string {
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return createHash('sha1')
      .update(toSign + this.apiSecret)
      .digest('hex');
  }

  /**
   * Tạo vé tải lên cho một chuyến.
   *
   * [sizeBytes] do client khai báo nên chỉ dùng để chặn sớm cho đỡ tốn công;
   * giới hạn thật vẫn do Cloudinary áp theo cấu hình tài khoản.
   */
  createUploadTicket(
    tripId: string,
    userId: string,
    contentType: string,
    sizeBytes?: number,
  ): UploadTicket {
    if (!this.configured) {
      throw new ServiceUnavailableException('errors.storage.notConfigured');
    }

    const allowed = ALLOWED[contentType];
    if (!allowed) {
      throw new BadRequestException('errors.storage.typeNotAllowed');
    }
    if (sizeBytes && sizeBytes > MAX_BYTES[allowed.kind]) {
      throw new BadRequestException('errors.storage.tooLarge');
    }

    // Tên file do server đặt: không dùng tên gốc để tránh ký tự lạ, và để người
    // khác không đoán được đường dẫn ảnh của mình.
    const publicId = `${this.folder}/trips/${tripId}/${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const params: Record<string, string> = {
      public_id: publicId,
      timestamp: String(timestamp),
    };
    const signature = this.sign(params);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloudName}/${allowed.kind}/upload`,
      fields: {
        ...params,
        api_key: this.apiKey!,
        signature,
      },
      publicId,
      // Cloudinary chấp nhận chữ ký trong khoảng 1 giờ.
      expiresAt: new Date((timestamp + 3600) * 1000).toISOString(),
    };
  }

  /**
   * Ghi lại file đã tải lên vào bảng `media`.
   *
   * Bảng này đã có sẵn trong schema nhưng chưa từng được dùng. Ghi vào đây để
   * sau này đo được dung lượng mỗi người và dọn ảnh mồ côi (upload xong nhưng
   * app crash trước khi tạo moment).
   */
  async recordMedia(
    userId: string,
    url: string,
    contentType: string,
    sizeBytes?: number,
  ) {
    const kind = ALLOWED[contentType]?.kind ?? 'raw';
    const type: MediaType = kind === 'video' ? 'VIDEO' : 'IMAGE';
    return this.prisma.media.create({
      data: { userId, type, url, sizeBytes: sizeBytes ?? null },
    });
  }

  /**
   * Biến URL gốc thành URL đã tối ưu.
   *
   * Đây là lý do chọn Cloudinary: app đang dùng CÙNG một ảnh gốc cho marker
   * 50×50 trên bản đồ lẫn ảnh xem toàn màn hình. `f_auto,q_auto` cho Cloudinary
   * tự chọn định dạng (WebP/AVIF) và mức nén; thêm `w_` để lấy đúng cỡ cần.
   */
  static optimized(url: string, width?: number): string {
    if (!url.includes('/upload/')) return url;
    const t = ['f_auto', 'q_auto'];
    if (width) t.push(`w_${width}`, 'c_limit');
    return url.replace('/upload/', `/upload/${t.join(',')}/`);
  }
}
