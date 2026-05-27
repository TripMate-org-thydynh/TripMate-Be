import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Clean existing data (safe delete order)
  await prisma.gameSession.deleteMany({});
  await prisma.momentReaction.deleteMany({});
  await prisma.momentComment.deleteMany({});
  await prisma.moment.deleteMany({});
  await prisma.expenseSplit.deleteMany({});
  await prisma.expense.deleteMany({});
  await prisma.itineraryItem.deleteMany({});
  await prisma.tripMember.deleteMany({});
  await prisma.trip.deleteMany({});
  await prisma.user.deleteMany({});

  console.log('🧹 Cleaned existing database records.');

  // 2. Create Users (no password - using Supabase Auth)
  const user1 = await prisma.user.create({
    data: {
      email: 'alex.genz@tripmate.com',
      supabaseId: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Alex Nguyễn',
      username: 'alexnguyen',
      bio: 'Thích phượt và ăn vặt 🍜',
      vibeTags: ['chill', 'foodie', 'adventure'],
      avatarUrl: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=150&q=80',
    },
  });

  const user2 = await prisma.user.create({
    data: {
      email: 'linh.cute@tripmate.com',
      supabaseId: 'bbbbbbbb-0000-0000-0000-000000000002',
      name: 'Linh Trương',
      username: 'linhtruong',
      bio: 'Sống để ăn & đi 🌏',
      vibeTags: ['foodie', 'instagrammer'],
      avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=150&q=80',
    },
  });

  const user3 = await prisma.user.create({
    data: {
      email: 'minh.phuot@tripmate.com',
      supabaseId: 'cccccccc-0000-0000-0000-000000000003',
      name: 'Minh Hoàng',
      username: 'minhphuot',
      bio: 'Đỉnh núi nào tao cũng leo 🏔️',
      vibeTags: ['adventure', 'camping', 'chaos'],
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&q=80',
    },
  });

  console.log(`👤 Created 3 users.`);

  // 3. Create Trips
  const trip1 = await prisma.trip.create({
    data: {
      name: 'Phượt Đà Lạt - Săn Mây Chill Chill',
      description: 'Chuyến đi chill nhất hè 2026',
      startDate: new Date('2026-06-15'),
      endDate: new Date('2026-06-18'),
      coverImage: 'https://images.unsplash.com/photo-1589308078059-be1415eab4c3?auto=format&fit=crop&w=800&q=80',
      inviteCode: 'DALAT6',
      currency: 'VND',
      createdBy: user1.id,
    },
  });

  const trip2 = await prisma.trip.create({
    data: {
      name: 'Chinh Phục Lũng Cú - Hà Giang',
      description: 'Bắc tiến mùa hoa tam giác mạch',
      startDate: new Date('2026-08-20'),
      endDate: new Date('2026-08-24'),
      coverImage: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80',
      inviteCode: 'HAGI88',
      currency: 'VND',
      createdBy: user2.id,
    },
  });

  console.log(`✈️ Created 2 trips.`);

  // 4. Create Trip Members
  await prisma.tripMember.createMany({
    data: [
      { tripId: trip1.id, userId: user1.id, role: 'CREATOR' },
      { tripId: trip1.id, userId: user2.id, role: 'MEMBER' },
      { tripId: trip1.id, userId: user3.id, role: 'MEMBER' },
      { tripId: trip2.id, userId: user2.id, role: 'CREATOR' },
      { tripId: trip2.id, userId: user1.id, role: 'MEMBER' },
    ],
  });

  console.log(`👥 Created trip members.`);

  // 5. Create Itinerary Items
  await prisma.itineraryItem.createMany({
    data: [
      {
        tripId: trip1.id, day: 1, startTime: '08:00',
        placeName: 'Hồ Tuyền Lâm', placeAddress: 'Phường 4, Đà Lạt',
        latitude: 11.9126, longitude: 108.4324, durationMinutes: 120,
        notes: 'Chèo thuyền SUP ngắm sương mù buổi sáng sớm siêu chill!',
      },
      {
        tripId: trip1.id, day: 1, startTime: '13:00',
        placeName: 'Tiệm Cà Phê Túi Mơ To', placeAddress: 'Hẻm 31 Sào Nam, P.11, Đà Lạt',
        latitude: 11.9424, longitude: 108.4719, durationMinutes: 90,
        notes: 'Check-in vườn cúc họa mi huyền thoại, uống cafe ngắm thung lũng.',
      },
      {
        tripId: trip1.id, day: 2, startTime: '04:30',
        placeName: 'Đồi Săn Mây Trại Mát', placeAddress: 'Trại Mát, Đà Lạt',
        latitude: 11.9406, longitude: 108.4897, durationMinutes: 180,
        notes: 'Dậy sớm đi xe máy săn mây đón bình minh. Chuẩn bị áo ấm.',
      },
    ],
  });

  console.log(`📅 Created itinerary.`);

  // 6. Create Expenses
  const expense1 = await prisma.expense.create({
    data: {
      tripId: trip1.id, paidById: user1.id,
      amount: 1500000, category: 'ACCOMMODATION',
      description: 'Tiền thuê homestay gỗ 3 đêm', splitType: 'EQUAL',
    },
  });
  await prisma.expenseSplit.createMany({
    data: [
      { expenseId: expense1.id, userId: user1.id, shareAmount: 500000, isPaid: true, paidAt: new Date() },
      { expenseId: expense1.id, userId: user2.id, shareAmount: 500000, isPaid: false },
      { expenseId: expense1.id, userId: user3.id, shareAmount: 500000, isPaid: false },
    ],
  });

  const expense2 = await prisma.expense.create({
    data: {
      tripId: trip1.id, paidById: user2.id,
      amount: 450000, category: 'FOOD',
      description: 'Lẩu gà lá é ăn tối ngày 1', splitType: 'EQUAL',
    },
  });
  await prisma.expenseSplit.createMany({
    data: [
      { expenseId: expense2.id, userId: user1.id, shareAmount: 150000, isPaid: false },
      { expenseId: expense2.id, userId: user2.id, shareAmount: 150000, isPaid: true, paidAt: new Date() },
      { expenseId: expense2.id, userId: user3.id, shareAmount: 150000, isPaid: false },
    ],
  });

  console.log(`💸 Created expenses.`);

  // 7. Create Moments
  await prisma.moment.createMany({
    data: [
      {
        tripId: trip1.id, userId: user1.id,
        mediaUrl: 'https://images.unsplash.com/photo-1508873535684-277a3cbcc4e8?auto=format&fit=crop&w=600&q=80',
        caption: 'Bình minh rực rỡ trên đỉnh đồi Trại Mát! 💯',
        latitude: 11.940562, longitude: 108.489723,
      },
      {
        tripId: trip1.id, userId: user2.id,
        mediaUrl: 'https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=600&q=80',
        caption: 'Góc ngồi nhỏ yên bình tại Túi Mơ To 🌼',
        latitude: 11.942385, longitude: 108.471922,
      },
    ],
  });

  console.log(`📸 Created moments.`);

  // 8. Create Game Session
  await prisma.gameSession.create({
    data: {
      tripId: trip1.id, gameType: 'TRUTH_OR_DARE',
      stateJson: {
        currentTurn: user1.name,
        question: 'Thách hay Thật?',
        scores: { [user1.name]: 15, [user2.name]: 20, [user3.name]: 10 },
      },
    },
  });

  console.log(`🎮 Created game session.`);
  console.log('✅ Seeding complete!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
