import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  STICKER_CATALOG,
  THEME_CATALOG,
  findSticker,
  findTheme,
} from './store.catalog';
import { XpService } from './xp.service';

/**
 * Cửa hàng đổi XP.
 *
 * Trước đây `purchaseSticker` không đọc tới `costXP`, không trừ gì, và đẩy kết
 * quả vào một object trong RAM — mua bao nhiêu cũng được, miễn phí, và mất sạch
 * sau mỗi lần backend khởi động lại. Nay mọi lần mua đều trừ XP thật trong một
 * transaction và ghi vào `xp_ledger`.
 */
@Injectable()
export class StoreService {
  constructor(
    private prisma: PrismaService,
    private xp: XpService,
  ) {}

  /** Cửa hàng sticker kèm cờ đã sở hữu và có đủ XP để mua hay không. */
  async getStickerStore(userId: string) {
    const [owned, user] = await Promise.all([
      this.prisma.userSticker.findMany({
        where: { userId },
        select: { stickerId: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { xpBalance: true },
      }),
    ]);
    const ownedIds = new Set(owned.map((o) => o.stickerId));

    return STICKER_CATALOG.map((s) => ({
      ...s,
      owned: ownedIds.has(s.id),
      affordable: user.xpBalance >= s.costXp,
    }));
  }

  /** Kho sticker THẬT của tôi — đọc từ bảng, không phải từ RAM. */
  async getMyStickers(userId: string) {
    const rows = await this.prisma.userSticker.findMany({
      where: { userId },
      orderBy: { acquiredAt: 'desc' },
    });
    // Bỏ qua sticker đã rút khỏi danh mục để client không phải vẽ ô trống.
    return rows
      .map((r) => {
        const item = findSticker(r.stickerId);
        if (!item) return null;
        return { ...item, acquiredAt: r.acquiredAt };
      })
      .filter((x) => x !== null);
  }

  async purchaseSticker(userId: string, stickerId: string) {
    const item = findSticker(stickerId);
    if (!item) throw new NotFoundException('errors.store.stickerNotFound');

    return this.prisma.$transaction(async (tx) => {
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      }

      const already = await tx.userSticker.findUnique({
        where: { userId_stickerId: { userId, stickerId } },
      });
      if (already) throw new BadRequestException('errors.store.alreadyOwned');

      const { balance } = await this.xp.spend(
        userId,
        item.costXp,
        'STICKER_PURCHASE',
        stickerId,
        { tx },
      );

      await tx.userSticker.create({ data: { userId, stickerId } });

      return { stickerId, spent: item.costXp, balance };
    });
  }

  /** Chợ theme kèm cờ đã mở khoá. */
  async getThemeMarketplace(userId: string) {
    const [owned, user] = await Promise.all([
      this.prisma.userTheme.findMany({
        where: { userId },
        select: { themeId: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { xpBalance: true },
      }),
    ]);
    const ownedIds = new Set(owned.map((o) => o.themeId));

    return THEME_CATALOG.map((t) => ({
      ...t,
      owned: ownedIds.has(t.id),
      affordable: user.xpBalance >= t.priceXp,
    }));
  }

  /** Accent người dùng được phép chọn — app dùng để khoá các theme chưa mua. */
  async getMyThemes(userId: string) {
    const rows = await this.prisma.userTheme.findMany({
      where: { userId },
      orderBy: { acquiredAt: 'desc' },
    });
    return rows
      .map((r) => {
        const item = findTheme(r.themeId);
        if (!item) return null;
        return { ...item, acquiredAt: r.acquiredAt };
      })
      .filter((x) => x !== null);
  }

  async purchaseTheme(userId: string, themeId: string) {
    const item = findTheme(themeId);
    if (!item) throw new NotFoundException('errors.store.themeNotFound');

    return this.prisma.$transaction(async (tx) => {
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      }

      const already = await tx.userTheme.findUnique({
        where: { userId_themeId: { userId, themeId } },
      });
      if (already) throw new BadRequestException('errors.store.alreadyOwned');

      const { balance } = await this.xp.spend(
        userId,
        item.priceXp,
        'THEME_PURCHASE',
        themeId,
        { tx },
      );

      await tx.userTheme.create({ data: { userId, themeId } });

      return {
        themeId,
        accentKey: item.accentKey,
        spent: item.priceXp,
        balance,
      };
    });
  }

  /** Người này có sở hữu sticker đó không — chat gọi để chặn gửi sticker chưa mua. */
  async ownsSticker(userId: string, stickerId: string): Promise<boolean> {
    const row = await this.prisma.userSticker.findUnique({
      where: { userId_stickerId: { userId, stickerId } },
    });
    return row !== null;
  }
}
