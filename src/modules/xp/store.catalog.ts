/**
 * Danh mục sticker và theme bán bằng XP.
 *
 * Đây là danh mục do team soạn (giống thực đơn), không phải dữ liệu người dùng —
 * nên để cứng trong mã là đúng. Cái trước đây sai là *kho đã sở hữu* bị để trong
 * RAM và *giá* không bao giờ bị trừ.
 *
 * Sticker dùng emoji thay vì file ảnh: `assetUrl: 'assets/stickers/laugh.png'`
 * trong bản cũ trỏ vào thư mục **không tồn tại** trong app, và app vốn cũng chỉ
 * lấy emoji cuối nhãn ra vẽ.
 */

export interface StickerItem {
  id: string;
  emoji: string;
  /** Khoá i18n, client dịch. */
  labelKey: string;
  costXp: number;
  rarity: 'COMMON' | 'RARE' | 'EPIC';
}

export interface ThemeItem {
  id: string;
  /** Khớp với `AppAccent.key` trong app — mua xong là chọn được thật. */
  accentKey: string;
  labelKey: string;
  priceXp: number;
  /** Màu nhấn, để cửa hàng xem trước mà không cần file ảnh. */
  colorHex: string;
}

export const STICKER_CATALOG: readonly StickerItem[] = [
  {
    id: 'stk-laugh',
    emoji: '😂',
    labelKey: 'laugh',
    costXp: 100,
    rarity: 'COMMON',
  },
  {
    id: 'stk-roast',
    emoji: '😜',
    labelKey: 'roast',
    costXp: 120,
    rarity: 'COMMON',
  },
  {
    id: 'stk-broke',
    emoji: '💸',
    labelKey: 'broke',
    costXp: 150,
    rarity: 'COMMON',
  },
  {
    id: 'stk-party',
    emoji: '🚀',
    labelKey: 'party',
    costXp: 180,
    rarity: 'RARE',
  },
  {
    id: 'stk-fire',
    emoji: '🔥',
    labelKey: 'fire',
    costXp: 200,
    rarity: 'RARE',
  },
  { id: 'stk-cry', emoji: '😭', labelKey: 'cry', costXp: 220, rarity: 'RARE' },
  {
    id: 'stk-skull',
    emoji: '💀',
    labelKey: 'skull',
    costXp: 350,
    rarity: 'EPIC',
  },
  {
    id: 'stk-crown',
    emoji: '👑',
    labelKey: 'crown',
    costXp: 500,
    rarity: 'EPIC',
  },
] as const;

export const THEME_CATALOG: readonly ThemeItem[] = [
  {
    id: 'theme-neon',
    accentKey: 'neon',
    labelKey: 'neon',
    priceXp: 600,
    colorHex: '#FF2E93',
  },
  {
    id: 'theme-pine',
    accentKey: 'pine',
    labelKey: 'pine',
    priceXp: 400,
    colorHex: '#0F766E',
  },
  {
    id: 'theme-cyber',
    accentKey: 'cyber',
    labelKey: 'cyber',
    priceXp: 900,
    colorHex: '#3D8BFF',
  },
] as const;

export const findSticker = (id: string) =>
  STICKER_CATALOG.find((s) => s.id === id);

export const findTheme = (id: string) => THEME_CATALOG.find((t) => t.id === id);
