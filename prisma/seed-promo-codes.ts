import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Nạp các mã giảm giá vào bảng `promo_codes`.
 *
 * Ba mã dưới đây trước nằm cứng trong một object của `PremiumService`. Chuyển
 * vào bảng để đổi khuyến mãi không phải sửa mã nguồn và triển khai lại — và để
 * mức giảm cuối cùng có chỗ mà áp vào giá.
 *
 * `upsert` nên chạy lại bao nhiêu lần cũng được: nó cập nhật mã đã có thay vì
 * ném lỗi trùng, và **không đụng tới các lượt đã dùng**.
 *
 *   npx ts-node prisma/seed-promo-codes.ts
 */
const CODES = [
  {
    code: 'MATEYCHAT',
    description: 'Giảm 15% mừng Matey Companion ra mắt',
    discountPercent: 0.15,
    // Có hạn dùng: một khuyến mãi ra mắt mà chạy vĩnh viễn thì không còn là
    // khuyến mãi ra mắt, nó là bảng giá mới.
    validUntil: new Date('2026-12-31T23:59:59Z'),
    maxRedemptions: 1000,
    perUserLimit: 1,
  },
  {
    code: 'DALATCHILL',
    description: 'Giảm 20% cho gói Squad',
    discountPercent: 0.2,
    // Chỉ áp cho Squad, đúng như tên gọi. Trước đây mã nào cũng áp cho mọi gói
    // vì không có chỗ nào ghi phạm vi.
    appliesToPlans: ['SQUAD' as const],
    validUntil: new Date('2026-12-31T23:59:59Z'),
    maxRedemptions: 500,
    perUserLimit: 1,
  },
  {
    code: 'ELITESQUAD',
    description: 'Giảm nửa giá tháng đầu',
    discountPercent: 0.5,
    validUntil: new Date('2026-12-31T23:59:59Z'),
    maxRedemptions: 200,
    perUserLimit: 1,
  },
];

async function main() {
  for (const c of CODES) {
    const data = {
      description: c.description,
      discountPercent: c.discountPercent,
      appliesToPlans: c.appliesToPlans ?? [],
      maxRedemptions: c.maxRedemptions,
      perUserLimit: c.perUserLimit,
      validUntil: c.validUntil,
      isActive: true,
    };
    await prisma.promoCode.upsert({
      where: { code: c.code },
      create: { code: c.code, ...data },
      update: data,
    });
    console.log(`✔ ${c.code} — ${c.description}`);
  }
  console.log(`\nĐã nạp ${CODES.length} mã giảm giá.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
