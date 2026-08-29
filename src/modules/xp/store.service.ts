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

    const already = await this.prisma.userSticker.findUnique({
      where: { userId_stickerId: { userId, stickerId } },
    });
    // Sở hữu là nhị phân: mua rồi thì dùng bao nhiêu lần cũng được, nên mua lại
    // chỉ tổ mất XP.
    if (already) throw new BadRequestException('errors.store.alreadyOwned');

    // Trừ trước rồi mới ghi sở hữu: nếu ghi sở hữu hỏng thì transaction bên
    // dưới cuốn ngược cả hai.
    const { balance } = await this.xp.spend(
      userId,
      item.costXp,
      'STICKER_PURCHASE',
      stickerId,
    );

    try {
      await this.prisma.userSticker.create({ data: { userId, stickerId } });
    } catch (e) {
      // Hoàn XP nếu không ghi được quyền sở hữu — người dùng không được mất XP
      // vì lỗi của mình.
      await this.xp.award(userId, 'ADMIN_ADJUST', {
        refId: `refund-${stickerId}-${Date.now()}`,
        amount: item.costXp,
      });
      throw e;
    }

    return { stickerId, spent: item.costXp, balance };
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

    const already = await this.prisma.userTheme.findUnique({
      where: { userId_themeId: { userId, themeId } },
    });
    if (already) throw new BadRequestException('errors.store.alreadyOwned');

    const { balance } = await this.xp.spend(
      userId,
      item.priceXp,
      'THEME_PURCHASE',
      themeId,
    );

    try {
      await this.prisma.userTheme.create({ data: { userId, themeId } });
    } catch (e) {
      await this.xp.award(userId, 'ADMIN_ADJUST', {
        refId: `refund-${themeId}-${Date.now()}`,
        amount: item.priceXp,
      });
      throw e;
    }

    return { themeId, accentKey: item.accentKey, spent: item.priceXp, balance };
  }

  /** Người này có sở hữu sticker đó không — chat gọi để chặn gửi sticker chưa mua. */
  async ownsSticker(userId: string, stickerId: string): Promise<boolean> {
    const row = await this.prisma.userSticker.findUnique({
      where: { userId_stickerId: { userId, stickerId } },
    });
    return row !== null;
  }
}
