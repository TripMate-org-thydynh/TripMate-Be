/**
 * Dữ liệu tối thiểu mà các bộ e2e cần có sẵn trong database TEST.
 *
 * Trước đây các bộ này dựa vào user `demo_tripmate` và mã giảm giá tồn tại
 * sẵn trong database production. Seed ở đây để database test tự đủ.
 *
 * Chạy qua `npm run test:db:up`; tự từ chối nếu DATABASE_URL không phải local.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

const url = process.env.DATABASE_URL ?? '';
if (!/@(localhost|127\.0\.0\.1):/.test(url)) {
  console.error('DATABASE_URL không phải local — không seed.');
  process.exit(1);
}

const prisma = new PrismaClient();

// Tài khoản mà webhook/sepay/checkout/entitlement e2e đăng nhập.
const passwordHash = await bcrypt.hash('matkhau123', 10);
await prisma.user.upsert({
  where: { username: 'demo_tripmate' },
  update: { passwordHash, isLocked: false, deletedAt: null },
  create: {
    id: randomUUID(),
    supabaseId: randomUUID(),
    email: 'demo_tripmate@test.local',
    name: 'Demo TripMate',
    username: 'demo_tripmate',
    passwordHash,
  },
});

// Mã giảm giá mà referral-promo e2e dùng — cùng nguồn với seed:promo.
const { execSync } = await import('child_process');
execSync('npx ts-node prisma/seed-promo-codes.ts', { stdio: 'inherit' });

console.log('Seed dữ liệu test xong.');
await prisma.$disconnect();
