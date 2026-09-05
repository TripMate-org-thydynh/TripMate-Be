import { PackingTemplate } from './dto/apply-template.dto';

export interface TemplateItem {
  name: string;
  category: string;
  quantity?: number;
}

/**
 * Bộ item mặc định cho mỗi loại chuyến. Category khớp với các nhóm hiển thị
 * ở client (CLOTHES, TOILETRIES, GADGETS, DOCS, OTHER).
 */
export const PACKING_TEMPLATES: Record<PackingTemplate, TemplateItem[]> = {
  [PackingTemplate.ESSENTIALS]: [
    { name: 'CCCD / Passport', category: 'DOCS' },
    { name: 'Ví + tiền mặt', category: 'DOCS' },
    { name: 'Sạc điện thoại', category: 'GADGETS' },
    { name: 'Pin dự phòng', category: 'GADGETS' },
    { name: 'Bàn chải + kem đánh răng', category: 'TOILETRIES' },
    { name: 'Thuốc cá nhân', category: 'OTHER' },
  ],
  [PackingTemplate.BEACH]: [
    { name: 'Đồ bơi', category: 'CLOTHES' },
    { name: 'Kem chống nắng', category: 'TOILETRIES' },
    { name: 'Kính râm', category: 'OTHER' },
    { name: 'Khăn tắm', category: 'TOILETRIES' },
    { name: 'Dép lê', category: 'CLOTHES' },
    { name: 'Mũ rộng vành', category: 'CLOTHES' },
  ],
  [PackingTemplate.CAMPING]: [
    { name: 'Lều', category: 'OTHER' },
    { name: 'Túi ngủ', category: 'OTHER' },
    { name: 'Đèn pin', category: 'GADGETS' },
    { name: 'Áo khoác giữ nhiệt', category: 'CLOTHES' },
    { name: 'Bình nước', category: 'OTHER' },
    { name: 'Bộ sơ cứu', category: 'OTHER' },
  ],
  [PackingTemplate.CITY]: [
    { name: 'Giày đi bộ', category: 'CLOTHES' },
    { name: 'Áo khoác nhẹ', category: 'CLOTHES' },
    { name: 'Ô / dù gấp', category: 'OTHER' },
    { name: 'Tai nghe', category: 'GADGETS' },
    { name: 'Túi đeo chéo', category: 'OTHER' },
  ],
};
