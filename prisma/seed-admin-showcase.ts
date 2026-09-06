import {
  PrismaClient,
  Plan,
  SubStatus,
  PaymentProvider,
  ReservationType,
  ExpenseCategory,
  TripRole,
  ActivityType,
} from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Seeding Admin Showcase Data...');

  // 1. Lấy danh sách users
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    take: 30,
  });

  if (users.length < 5) {
    console.error('⚠️ Không đủ users trong DB để seed. Cần chạy seed chính trước.');
    return;
  }

  const admin = users.find((u) => u.role === 'ADMIN') || users[0];
  const normalUsers = users.filter((u) => u.id !== admin.id);

  console.log(`👤 Tìm thấy ${users.length} users, gồm admin: ${admin.username}`);

  // 2. Tạo hoặc bổ sung chuyến đi hấp dẫn
  const destinations = [
    { name: 'Đà Lạt Chill Vibes 🌸', dest: 'Đà Lạt', vibe: 'chill', days: 4 },
    { name: 'Phú Quốc Sunset & Beach Party 🏖️', dest: 'Phú Quốc', vibe: 'party', days: 5 },
    { name: 'Săn mây Tà Xùa & Fansipan 🏔️', dest: 'Sa Pa', vibe: 'adventure', days: 3 },
    { name: 'Foodtour Đà Nẵng - Hội An 🍜', dest: 'Đà Nẵng', vibe: 'foodie', days: 4 },
    { name: 'Quy Nhơn Eo Gió & Kỳ Co 🌊', dest: 'Quy Nhơn', vibe: 'relax', days: 3 },
    { name: 'Cắm trại Hồ Trị An cuối tuần ⛺', dest: 'Đồng Nai', vibe: 'camping', days: 2 },
  ];

  const now = new Date();
  const trips: any[] = [];

  for (let i = 0; i < destinations.length; i++) {
    const item = destinations[i];
    console.log(`Checking trip ${i + 1}/${destinations.length}: ${item.name}`);
    const inviteCode = `SHOW${i + 1}${Math.floor(100 + Math.random() * 900)}`;
    const creator = normalUsers[i % normalUsers.length];

    const startDate = new Date(now.getTime() - i * 3 * 24 * 60 * 60 * 1000);
    const endDate = new Date(startDate.getTime() + item.days * 24 * 60 * 60 * 1000);
    const createdAt = new Date(now.getTime() - (25 - i * 4) * 24 * 60 * 60 * 1000);

    console.log('Querying findFirst for:', item.name);
    let trip = await prisma.trip.findFirst({
      where: { name: item.name, deletedAt: null },
    });
    console.log('Result of findFirst:', trip ? trip.id : 'Not found');

    if (!trip) {
      trip = await prisma.trip.create({
        data: {
          name: item.name,
          destination: item.dest,
          description: `Chuyến đi khám phá ${item.dest} cùng hội bạn thân Gen Z!`,
          startDate,
          endDate,
          inviteCode,
          createdBy: creator.id,
          vibe: item.vibe,
          currency: 'VND',
          budget: (item.days * 3500000) as any,
          createdAt,
        },
      });
    }
    trips.push(trip);

    // Add 3-5 members into each trip
    const memberCount = 3 + (i % 3);
    for (let m = 0; m < memberCount; m++) {
      const u = normalUsers[(i + m) % normalUsers.length];
      const exists = await prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId: trip.id, userId: u.id } },
      });
      if (!exists) {
        await prisma.tripMember.create({
          data: {
            tripId: trip.id,
            userId: u.id,
            role: m === 0 ? TripRole.CREATOR : TripRole.MEMBER,
            joinedAt: new Date(createdAt.getTime() + m * 3600 * 1000),
          },
        });
      }
    }

    // Add recent activities in last 7 days (North Star metric trigger)
    const actTypes = [
      ActivityType.EXPENSE_ADDED,
      ActivityType.MOMENT_SHARED,
      ActivityType.CHAT_SENT,
      ActivityType.ITINERARY_ADDED,
    ];
    for (let a = 0; a < 3; a++) {
      const actDate = new Date(now.getTime() - (a * 24 + i * 12) * 3600 * 1000);
      const actUser = normalUsers[(i + a) % normalUsers.length];
      await prisma.activity.create({
        data: {
          tripId: trip.id,
          userId: actUser.id,
          type: actTypes[a % actTypes.length],
          data: {
            description: `${actUser.name} đã cập nhật hành trình chuyến ${item.name}`,
          },
          createdAt: actDate,
        },
      });
    }
  }

  console.log(`✈️ Đã tạo & cập nhật ${trips.length} chuyến đi và hoạt động.`);

  // 3. Seed Subscriptions (PLUS, SQUAD, ACTIVE, CANCELING, PAST_DUE, EXPIRED)
  console.log('💳 Đang seed Subscriptions...');
  const subSpecs = [
    { plan: Plan.PLUS, status: SubStatus.ACTIVE, provider: PaymentProvider.MOMO, daysLeft: 25, cancelAtPeriodEnd: false, seats: 1 },
    { plan: Plan.SQUAD, status: SubStatus.ACTIVE, provider: PaymentProvider.ZALOPAY, daysLeft: 20, cancelAtPeriodEnd: false, seats: 4 },
    { plan: Plan.PLUS, status: SubStatus.ACTIVE, provider: PaymentProvider.BANK_TRANSFER, daysLeft: 18, cancelAtPeriodEnd: false, seats: 1 },
    { plan: Plan.SQUAD, status: SubStatus.ACTIVE, provider: PaymentProvider.VNPAY, daysLeft: 5, cancelAtPeriodEnd: false, seats: 4 },
    { plan: Plan.PLUS, status: SubStatus.ACTIVE, provider: PaymentProvider.MOMO, daysLeft: 2, cancelAtPeriodEnd: true, seats: 1 }, // Expiring soon
    { plan: Plan.SQUAD, status: SubStatus.ACTIVE, provider: PaymentProvider.MOMO, daysLeft: 1, cancelAtPeriodEnd: true, seats: 4 }, // Expiring soon
    { plan: Plan.PLUS, status: SubStatus.ACTIVE, provider: PaymentProvider.ZALOPAY, daysLeft: 15, cancelAtPeriodEnd: false, seats: 1 },
    { plan: Plan.PLUS, status: SubStatus.PAST_DUE, provider: PaymentProvider.MOMO, daysLeft: -2, cancelAtPeriodEnd: false, seats: 1 },
    { plan: Plan.SQUAD, status: SubStatus.CANCELED, provider: PaymentProvider.VNPAY, daysLeft: -10, cancelAtPeriodEnd: true, seats: 4 },
    { plan: Plan.PLUS, status: SubStatus.ACTIVE, provider: PaymentProvider.MOMO, daysLeft: 28, cancelAtPeriodEnd: false, seats: 1 },
    { plan: Plan.SQUAD, status: SubStatus.ACTIVE, provider: PaymentProvider.ZALOPAY, daysLeft: 12, cancelAtPeriodEnd: false, seats: 4 },
  ];

  for (let s = 0; s < subSpecs.length; s++) {
    const spec = subSpecs[s];
    const subUser = normalUsers[s % normalUsers.length];

    const currentPeriodStart = new Date(now.getTime() - (30 - spec.daysLeft) * 24 * 60 * 60 * 1000);
    const currentPeriodEnd = new Date(now.getTime() + spec.daysLeft * 24 * 60 * 60 * 1000);

    const sub = await prisma.subscription.create({
      data: {
        userId: subUser.id,
        plan: spec.plan,
        status: spec.status,
        provider: spec.provider,
        externalId: `SHOWCASE_SUB_${Date.now()}_${s}`,
        seats: spec.seats,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: spec.cancelAtPeriodEnd,
        canceledAt: spec.status === SubStatus.CANCELED ? new Date() : null,
      },
    });

    // Add SquadSeats if SQUAD
    if (spec.plan === Plan.SQUAD) {
      for (let seatIdx = 0; seatIdx < 3; seatIdx++) {
        const assignedUser = normalUsers[(s + seatIdx + 1) % normalUsers.length];
        const seatExists = await prisma.squadSeat.findUnique({
          where: { subscriptionId_userId: { subscriptionId: sub.id, userId: assignedUser.id } },
        });
        if (!seatExists) {
          await prisma.squadSeat.create({
            data: {
              subscriptionId: sub.id,
              userId: assignedUser.id,
              grantedAt: new Date(),
            },
          });
        }
      }
    }
  }

  console.log(`✅ Đã seed ${subSpecs.length} gói đăng ký & ghế Squad.`);

  // 4. Seed Reservations (Đặt chỗ phong phú)
  console.log('🏨 Đang seed Reservations...');
  const reservationSpecs = [
    { type: ReservationType.FLIGHT, title: 'Vé máy bay khứ hồi SGN - DLI', loc: 'Sân bay Liên Khương, Đà Lạt', conf: 'VN1234DALAT', price: 2400000 },
    { type: ReservationType.HOTEL, title: 'Bamboo Dalat Hotel & Spa (2 phòng Deluxe)', loc: 'Đà Lạt, Lâm Đồng', conf: 'HTL-BAMBOO-88', price: 4200000 },
    { type: ReservationType.RESTAURANT, title: 'Bàn tiệc BBQ Lẩu Gà Lá É Tao Ngộ', loc: 'Số 5 Đường 3/4, Đà Lạt', conf: 'RES-TAONGO-09', price: 950000 },
    { type: ReservationType.FLIGHT, title: 'Vé máy bay Bamboo Airways SGN - PQC', loc: 'Sân bay Phú Quốc', conf: 'QH246PQC', price: 3100000 },
    { type: ReservationType.HOTEL, title: 'Premier Village Phu Quoc Resort', loc: 'Mũi Ông Đội, An Thới, Phú Quốc', conf: 'PQC-RESORT-01', price: 7800000 },
    { type: ReservationType.ATTRACTION, title: 'Vé Cáp treo Hòn Thơm & Công viên nước', loc: 'Hòn Thơm, Phú Quốc', conf: 'TKT-HONTHOM-4X', price: 1800000 },
    { type: ReservationType.TRAIN, title: 'Tàu hoả giường nằm Hà Nội - Lào Cai', loc: 'Ga Hà Nội', conf: 'SP1-LCA-99', price: 1350000 },
    { type: ReservationType.HOTEL, title: 'Pao\'s Sapa Leisure Hotel', loc: 'Mường Hoa, Sa Pa, Lào Cai', conf: 'PAO-SAPA-777', price: 3600000 },
    { type: ReservationType.ATTRACTION, title: 'Vé Cáp treo Sun World Fansipan Legend', loc: 'Đỉnh Fansipan, Sa Pa', conf: 'SUN-FANSIPAN-01', price: 2200000 },
    { type: ReservationType.CAR, title: 'Thuê xe ô tô tự lái 7 chỗ Xpander (3 ngày)', loc: 'Sân bay Đà Nẵng', conf: 'CAR-DN-XP7', price: 2700000 },
    { type: ReservationType.HOTEL, title: 'Chicland Hotel Danang Beach', loc: 'Võ Nguyên Giáp, Đà Nẵng', conf: 'DN-CHIC-55', price: 3200000 },
    { type: ReservationType.RESTAURANT, title: 'Hải sản Bé Mặn Đà Nẵng', loc: 'Lô 14 Hoàng Sa, Đà Nẵng', conf: 'BEMAN-DN-22', price: 1650000 },
    { type: ReservationType.CAR, title: 'Xe Limousine Sài Gòn - Vũng Tàu', loc: 'Bến xe Miền Đông', conf: 'LIMO-VT-33', price: 600000 },
    { type: ReservationType.EVENT, title: 'Vé xem show Ký ức Hội An (Hàng ECO)', loc: 'Công viên Ấn tượng Hội An', conf: 'SHOW-HOIAN-88', price: 1500000 },
  ];

  for (let r = 0; r < reservationSpecs.length; r++) {
    const spec = reservationSpecs[r];
    const targetTrip = trips[r % trips.length];
    const addedBy = normalUsers[r % normalUsers.length];

    await prisma.reservation.create({
      data: {
        tripId: targetTrip.id,
        addedBy: addedBy.id,
        type: spec.type,
        title: spec.title,
        location: spec.loc,
        confirmationNumber: spec.conf,
        price: spec.price as any,
        status: 'CONFIRMED',
        startTime: new Date(now.getTime() + (r + 1) * 24 * 3600 * 1000),
      },
    });
  }

  console.log(`🏨 Đã seed ${reservationSpecs.length} đặt chỗ đa dạng.`);

  // 5. Seed Journals (Nhật ký đầy cảm xúc)
  console.log('📖 Đang seed Journal Entries...');
  const journalSpecs = [
    { title: 'Sáng thức giấc ở một nơi xa ☕', body: 'Đà Lạt hôm nay se se lạnh, cả nhóm rủ nhau dậy từ 5h sáng săn mây đồi chè Cầu Đất. Cảnh tượng đẹp như tranh vẽ, sương mù giăng kín thung lũng!', mood: 'CHILL' },
    { title: 'Quẩy banh nóc tại Sunset Sanato 🌅', body: 'Hoàng hôn Phú Quốc đúng là huyền thoại! Nhạc xập xình, cocktail mát lạnh và những tấm hình sống ảo nghìn like.', mood: 'HAPPY' },
    { title: 'Chinh phục nóc nhà Đông Dương 3.143m 🚩', body: 'Gió trên đỉnh Fansipan rít từng cơn, lạnh buốt nhưng cảm giác chạm tay vào chóp inox thiêng liêng thực sự phấn khích không nói nên lời!', mood: 'ADVENTUROUS' },
    { title: 'Lạc lối trong thiên đường ẩm thực Đà Nẵng 🤤', body: 'Mì Quảng ếch, bánh tráng cuốn thịt heo hai đầu da, chè sầu Liên... ăn không kịp thở nhưng ngon xỉu!', mood: 'HAPPY' },
    { title: 'Chèo SUP đón bình minh Eo Gió 🏄‍♂️', body: 'Nước biển Kỳ Co trong vắt nhìn thấy cả đáy san hô. Sóng êm ru, cả nhóm lướt ván nhẹ nhàng ngắm mặt trời nhô lên từ đường chân trời.', mood: 'ADVENTUROUS' },
    { title: 'Đêm lửa trại đàn hát bên Hồ Trị An 🔥', body: 'Không khói bụi thành phố, không deadline. Chỉ có tiếng đàn guitar mộc, tiếng cười giòn tan và ngàn vì sao sáng rực trên bầu trời đêm.', mood: 'CHILL' },
    { title: 'Đi bộ rã cả chân mà vui hết nấc 😴', body: 'Hôm nay đi bộ quanh phố cổ Hội An hơn 15.000 bước. Chân mỏi nhừ nhưng bù lại mua được mấy chiếc đèn lồng xinh xắn.', mood: 'TIRED' },
    { title: 'Trải nghiệm lặn biển ngắm rạn san hô Nam Đảo 🤿', body: 'Lần đầu tiên lặn ngắm san hô tự nhiên, cá bơi tung tăng quanh tay như trong phim tài liệu National Geographic.', mood: 'ADVENTUROUS' },
  ];

  for (let j = 0; j < journalSpecs.length; j++) {
    const spec = journalSpecs[j];
    const targetTrip = trips[j % trips.length];
    const author = normalUsers[j % normalUsers.length];

    await prisma.journalEntry.create({
      data: {
        tripId: targetTrip.id,
        authorId: author.id,
        title: spec.title,
        body: spec.body,
        mood: spec.mood,
        entryDate: new Date(now.getTime() - j * 24 * 3600 * 1000),
      },
    });
  }

  console.log(`📖 Đã seed ${journalSpecs.length} bài nhật ký.`);

  // 6. Seed Expenses phong phú (để biểu đồ Donut chi tiêu có dữ liệu sinh động)
  console.log('💰 Đang seed Expenses...');
  const expenseCategories = [
    { cat: ExpenseCategory.FOOD, title: 'Ăn tối BBQ lẩu nướng', amount: 1450000 },
    { cat: ExpenseCategory.FOOD, title: 'Cafe Cheo Veooo ngắm hoàng hôn', amount: 320000 },
    { cat: ExpenseCategory.TRANSPORT, title: 'Tiền xăng xe máy 3 ngày', amount: 450000 },
    { cat: ExpenseCategory.TRANSPORT, title: 'Vé xe khách khứ hồi', amount: 1800000 },
    { cat: ExpenseCategory.ACCOMMODATION, title: 'Homestay Rừng Thông Đỏ', amount: 2800000 },
    { cat: ExpenseCategory.ENTERTAINMENT, title: 'Vé vào cổng nông trại cún Puppy Farm', amount: 500000 },
    { cat: ExpenseCategory.ACTIVITIES, title: 'Trượt thác Datanla máng trượt dài nhất ĐNA', amount: 900000 },
    { cat: ExpenseCategory.SHOPPING, title: 'Đặc sản dâu tây & mứt atiso làm quà', amount: 750000 },
    { cat: ExpenseCategory.OTHER, title: 'Mua áo mưa & dù tiện lợi', amount: 150000 },
  ];

  for (let e = 0; e < expenseCategories.length; e++) {
    const exp = expenseCategories[e];
    const targetTrip = trips[e % trips.length];
    const payer = normalUsers[e % normalUsers.length];

    await prisma.expense.create({
      data: {
        tripId: targetTrip.id,
        paidById: payer.id,
        description: exp.title,
        amount: exp.amount as any,
        category: exp.cat,
        createdAt: new Date(now.getTime() - e * 36 * 3600 * 1000),
      },
    });
  }

  console.log(`💰 Đã seed ${expenseCategories.length} hoá đơn chi tiêu.`);
  console.log('🎉 Hoàn tất nạp dữ liệu Showcase cho Admin TripMate!');
}

main()
  .catch((e) => {
    console.error('❌ Lỗi seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
