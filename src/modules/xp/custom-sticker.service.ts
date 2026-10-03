import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/** Tiền tố nội dung tin nhắn sticker cá nhân: `custom:<uuid>`. */
export const CUSTOM_STICKER_PREFIX = 'custom:';

/**
 * Giới hạn mỗi người. Mỗi sticker là một ảnh trên Cloudinary (tốn dung lượng)
 * và là nội dung người dùng tạo phải kiểm duyệt được — không cần vô hạn.
 */
export const MAX_CUSTOM_STICKERS = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CustomStickerService {
  private readonly cloudName?: string;

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    this.cloudName = config.get<string>('CLOUDINARY_CLOUD_NAME');
  }

  /**
   * Chỉ nhận ảnh trên Cloudinary của chính app (qua vé tải lên đã ký). Không
   * thì sticker thành đường lách để nhét URL bất kỳ — kể cả ảnh theo dõi —
   * vào tin nhắn của cả nhóm.
   */
  isOwnImage(url: string): boolean {
    if (typeof url !== 'string' || url.length > 2048) return false;
    const cloud = this.cloudName
      ? this.cloudName.replace(/[^a-zA-Z0-9_-]/g, '')
      : '[a-zA-Z0-9_-]+';
    return new RegExp(
      `^https://res\\.cloudinary\\.com/${cloud}/image/upload/[^\\s?#]+$`,
    ).test(url);
  }

  list(userId: string) {
    return this.prisma.customSticker.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, mediaUrl: true, label: true, createdAt: true },
    });
  }

  async create(userId: string, mediaUrl: string, label?: string) {
    if (!this.isOwnImage(mediaUrl)) {
      throw new BadRequestException('errors.storage.invalidUrl');
    }
    const count = await this.prisma.customSticker.count({
      where: { userId, deletedAt: null },
    });
    if (count >= MAX_CUSTOM_STICKERS) {
      throw new ForbiddenException('errors.store.customStickerLimit');
    }
    const clean = label?.trim().slice(0, 24) || null;
    return this.prisma.customSticker.create({
      data: { userId, mediaUrl, label: clean },
      select: { id: true, mediaUrl: true, label: true, createdAt: true },
    });
  }

  async remove(userId: string, id: string) {
    const r = await this.prisma.customSticker.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!r.count) throw new NotFoundException('errors.database.notFound');
    return { success: true };
  }

  /** URL ảnh của sticker `custom:<id>` nếu người gửi là chủ; không thì lỗi. */
  async resolveForSend(userId: string, content: string): Promise<string> {
    const id = content.slice(CUSTOM_STICKER_PREFIX.length);
    if (!UUID_RE.test(id)) {
      throw new NotFoundException('errors.store.stickerNotFound');
    }
    const s = await this.prisma.customSticker.findFirst({
      where: { id, deletedAt: null },
      select: { userId: true, mediaUrl: true },
    });
    if (!s) throw new NotFoundException('errors.store.stickerNotFound');
    if (s.userId !== userId) {
      throw new ForbiddenException('errors.store.stickerNotOwned');
    }
    return s.mediaUrl;
  }
}
