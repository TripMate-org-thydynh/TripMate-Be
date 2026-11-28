const { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

// Each duration and budget is an editorial planning allowance. Destinations
// are drawn from Vietnam Tourism guides, with no guaranteed hours or prices.
const destinations = [
  {
    city: 'Đà Lạt', key: 'dalat', source: 'https://vietnam.travel/things-to-do/8-things-to-do-in-dalat/',
    plans: [
      ['Ba ngày ở Đà Lạt', [1_400_000, 2_400_000], [
        [['14:00', 'Nhận phòng', 45], ['15:30', 'Cà phê trong phố', 60], ['17:30', 'Dạo hồ Xuân Hương', 75], ['19:00', 'Ăn tối cùng nhóm', 75]],
        [['07:00', 'Khởi hành đi hồ Tuyền Lâm', 50], ['09:00', 'Dạo rừng thông', 100], ['12:00', 'Ăn trưa cùng nhóm', 90], ['16:00', 'Về lại thành phố', 60]],
        [['08:30', 'Hẹn cà phê trong phố', 60], ['10:00', 'Ghé mua quà', 45], ['11:00', 'Trả phòng', 30], ['12:00', 'Chốt các khoản chi', 30]],
      ], 'Nếu trời mưa, đổi buổi đi rừng sang một quán cà phê trong phố.'],
      ['Đà Lạt đi chậm', [850_000, 1_550_000], [
        [['09:00', 'Chợ Đà Lạt', 80], ['13:30', 'Nhà thờ Domaine de Marie', 60], ['16:30', 'Hồ Xuân Hương', 90]],
        [['08:30', 'Ga Đà Lạt', 70], ['11:00', 'Ăn trưa trong phố', 75], ['14:00', 'Cà phê trước khi về', 60]],
      ], 'Nếu nhóm muốn đi bộ ít, giữ chợ và hồ làm hai điểm chính.'],
    ],
  },
  {
    city: 'Đà Nẵng', key: 'danang', source: 'https://vietnam.travel/place-to-go/south-central-coast-central-highlands/da-nang/',
    plans: [
      ['Cuối tuần bên biển Đà Nẵng', [950_000, 1_750_000], [
        [['08:00', 'Biển Mỹ Khê', 90], ['12:00', 'Ăn trưa quận Sơn Trà', 70], ['17:00', 'Dạo bờ sông Hàn', 90]],
        [['08:30', 'Bán đảo Sơn Trà', 120], ['11:00', 'Chùa Linh Ứng', 60], ['14:00', 'Cà phê trước khi về', 50]],
      ], 'Khi gió mạnh, đổi buổi biển sang Bảo tàng Điêu khắc Chăm.'],
      ['Đà Nẵng từ núi xuống biển', [1_500_000, 2_600_000], [
        [['09:00', 'Bảo tàng Điêu khắc Chăm', 90], ['15:30', 'Cầu Rồng và bờ sông', 90]],
        [['08:30', 'Ngũ Hành Sơn', 150], ['14:30', 'Biển Mỹ Khê', 110]],
        [['08:00', 'Sơn Trà', 140], ['12:00', 'Ăn trưa cùng nhóm', 75]],
      ], 'Nếu leo bậc khó, dành buổi Ngũ Hành Sơn cho biển và một quán gần đó.'],
    ],
  },
  {
    city: 'Hội An', key: 'hoian', source: 'https://vietnam.travel/vi/plan-your-trip/recommended-trip/heritage-sites-vietnam/',
    plans: [
      ['Hội An đi bộ và ăn tối', [850_000, 1_650_000], [
        [['09:00', 'Phố cổ Hội An', 120], ['14:00', 'Chùa Cầu và các phố quanh đó', 90], ['17:30', 'Bờ sông Hoài', 75]],
        [['08:00', 'Chợ Hội An', 80], ['11:30', 'Cao lầu cùng nhóm', 70], ['14:30', 'Cà phê trong phố cổ', 60]],
      ], 'Khi mưa, rút ngắn chặng ven sông và chọn một nhà cổ hoặc quán có mái che.'],
      ['Hội An từ phố ra biển', [1_350_000, 2_400_000], [
        [['10:00', 'Phố cổ Hội An', 140], ['17:00', 'Bờ sông Hoài', 90]],
        [['08:30', 'Trà Quế', 140], ['14:30', 'Biển An Bàng', 130]],
        [['08:30', 'Chợ Hội An', 90], ['11:30', 'Ăn trưa và chia chi phí', 80]],
      ], 'Nếu biển động, đổi An Bàng thành buổi làm thủ công trong phố.'],
    ],
  },
  {
    city: 'Huế', key: 'hue', source: 'https://vietnam.travel/place-to-go/north-central-coast/hue/',
    plans: [
      ['Hai ngày đi dọc sông Hương', [850_000, 1_600_000], [
        [['08:30', 'Đại Nội Huế', 140], ['13:00', 'Ăn trưa trong thành phố', 70], ['16:30', 'Bờ sông Hương', 75]],
        [['08:30', 'Chùa Thiên Mụ', 80], ['11:30', 'Chợ Đông Ba', 75], ['14:30', 'Chè Huế', 55]],
      ], 'Nếu trời nóng, chuyển buổi đi Đại Nội lên sớm và chọn quán nghỉ trưa có mái che.'],
      ['Ba ngày xem di sản Huế', [1_350_000, 2_450_000], [
        [['08:30', 'Đại Nội Huế', 150], ['16:00', 'Đi bộ ven sông Hương', 80]],
        [['08:30', 'Lăng Minh Mạng', 120], ['14:00', 'Lăng Khải Định', 95]],
        [['08:00', 'Làng hương Thủy Xuân', 95], ['11:30', 'Chợ Đông Ba', 85]],
      ], 'Nếu nhóm muốn đi chậm, chỉ chọn một lăng và để buổi còn lại tự do.'],
    ],
  },
  {
    city: 'Ninh Bình', key: 'ninhbinh', source: 'https://vietnam.travel/place-to-go/red-river-delta/ninh-binh/',
    plans: [
      ['Ninh Bình qua Tràng An và Hoa Lư', [1_000_000, 1_900_000], [
        [['08:00', 'Tràng An', 180], ['12:00', 'Ăn trưa cùng nhóm', 75], ['15:00', 'Cố đô Hoa Lư', 100]],
        [['08:30', 'Tam Cốc', 140], ['12:30', 'Ăn trưa rồi về', 75]],
      ], 'Nếu thuyền tạm dừng, đổi sang Hoa Lư trước và xác nhận lại lịch với bến.'],
      ['Ninh Bình thêm một ngày giữa đồng', [1_450_000, 2_600_000], [
        [['09:00', 'Tam Cốc', 135], ['15:30', 'Chùa Bích Động', 90]],
        [['08:00', 'Tràng An', 180], ['14:30', 'Cố đô Hoa Lư', 105]],
        [['08:00', 'Dạo đường làng khu Tam Cốc', 100], ['11:30', 'Ăn trưa và chia bill', 80]],
      ], 'Nếu đường trơn, thay đoạn đi bộ bằng một buổi nghỉ ngắn quanh chỗ ăn trưa.'],
    ],
  },
  {
    city: 'Hà Nội', key: 'hanoi', source: 'https://vietnam.travel/plan-your-trip/recommended-trip/heritage-sites-northern-vietnam/',
    plans: [
      ['Cuối tuần quanh Hồ Gươm', [800_000, 1_500_000], [
        [['08:00', 'Hồ Hoàn Kiếm', 90], ['11:30', 'Ăn trưa phố cổ', 65], ['15:30', 'Cà phê trứng', 65]],
        [['08:30', 'Văn Miếu – Quốc Tử Giám', 110], ['11:30', 'Ăn trưa với cả nhóm', 75], ['14:00', 'Ghé mua quà', 55]],
      ], 'Nếu trời mưa, dời chặng quanh hồ và bắt đầu trong một quán cà phê gần điểm hẹn.'],
      ['Hà Nội từ phố cổ tới Hồ Tây', [1_300_000, 2_200_000], [
        [['09:00', 'Hồ Hoàn Kiếm và phố cổ', 150], ['17:00', 'Ăn tối cùng nhóm', 80]],
        [['08:30', 'Văn Miếu – Quốc Tử Giám', 100], ['15:00', 'Hoàng thành Thăng Long', 110]],
        [['08:00', 'Hồ Tây', 105], ['11:30', 'Ăn trưa và tổng kết', 75]],
      ], 'Nếu nhóm đến muộn, dồn chặng phố cổ về chiều và giữ buổi sáng đầu tự do.'],
    ],
  },
];

function editorialId(key, planIndex) {
  const hash = createHash('sha256').update(`tripmate-editorial-${key}-${planIndex}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function seed(prisma, username) {
  const editor = await prisma.user.findFirst({
    where: { username, role: 'ADMIN', deletedAt: null }, select: { id: true },
  });
  if (!editor) throw new Error('The editorial account must be an active administrator.');
  let created = 0;
  for (const { city, key, source, plans } of destinations) {
    for (const [index, [title, [budgetFrom, budgetTo], days, fallback]] of plans.entries()) {
      const id = editorialId(key, index);
      const date = new Date();
      const items = days.flatMap((stops, dayIndex) => stops.map(([startTime, placeName, durationMinutes], stopIndex) => ({
        day: dayIndex + 1, startTime, placeName, durationMinutes,
        notes: stopIndex === 0
          ? 'Giữ thêm 20–40 phút đệm cho việc đi lại trong khu vực. ' + fallback
          : 'Thời lượng dự kiến. Hẹn một điểm tập trung và kiểm tra giờ di chuyển trước khi đi.',
      })));
      await prisma.itineraryTemplate.upsert({
        where: { id }, update: {},
        create: {
          id, authorId: editor.id, title, destination: city, budgetFrom, budgetTo,
          description: `${fallback} Ngân sách tham khảo mỗi người, gồm ăn uống, lưu trú chia nhóm và đi lại tại điểm đến. Nguồn địa danh: ${source}`,
          dayCount: days.length, stopCount: items.length, isPublic: true, isEditorial: true,
          reviewStatus: 'APPROVED', updatedAt: date, items: { create: items },
        },
      });
      created += 1;
    }
  }
  console.log(`Ensured ${created} editorial template records.`);
}

const username = process.env.TRIPMATE_EDITOR_USERNAME;
if (!username) throw new Error('Set TRIPMATE_EDITOR_USERNAME to the editorial admin username.');
const prisma = new PrismaClient();
seed(prisma, username).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
