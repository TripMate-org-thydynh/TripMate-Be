import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVacationDayDto } from './dto/create-vacation.dto';

// Vietnamese public holidays 2026-2027
const VN_HOLIDAYS: { date: string; name: string; key: string }[] = [
  { date: '2026-01-01', name: 'Tết Dương lịch', key: 'NEW_YEAR' },
  { date: '2026-01-28', name: 'Tết Nguyên Đán (Giao Thừa)', key: 'LUNAR_NEW_YEAR_EVE' },
  { date: '2026-01-29', name: 'Tết Nguyên Đán (Mùng 1)', key: 'LUNAR_NEW_YEAR_D1' },
  { date: '2026-01-30', name: 'Tết Nguyên Đán (Mùng 2)', key: 'LUNAR_NEW_YEAR_D2' },
  { date: '2026-01-31', name: 'Tết Nguyên Đán (Mùng 3)', key: 'LUNAR_NEW_YEAR_D3' },
  { date: '2026-02-01', name: 'Tết Nguyên Đán (Mùng 4)', key: 'LUNAR_NEW_YEAR_D4' },
  { date: '2026-02-02', name: 'Tết Nguyên Đán (Mùng 5)', key: 'LUNAR_NEW_YEAR_D5' },
  { date: '2026-04-18', name: 'Giỗ Tổ Hùng Vương', key: 'HUNG_KING_FESTIVAL' },
  { date: '2026-04-30', name: 'Ngày Giải Phóng Miền Nam', key: 'REUNIFICATION_DAY' },
  { date: '2026-05-01', name: 'Ngày Quốc tế Lao Động', key: 'LABOR_DAY' },
  { date: '2026-09-02', name: 'Ngày Quốc Khánh', key: 'INDEPENDENCE_DAY' },
  { date: '2026-09-03', name: 'Ngày Quốc Khánh (bù)', key: 'INDEPENDENCE_DAY_EXTRA' },
  { date: '2027-01-01', name: 'Tết Dương lịch', key: 'NEW_YEAR' },
  { date: '2027-02-16', name: 'Tết Nguyên Đán (Giao Thừa)', key: 'LUNAR_NEW_YEAR_EVE' },
  { date: '2027-02-17', name: 'Tết Nguyên Đán (Mùng 1)', key: 'LUNAR_NEW_YEAR_D1' },
  { date: '2027-02-18', name: 'Tết Nguyên Đán (Mùng 2)', key: 'LUNAR_NEW_YEAR_D2' },
  { date: '2027-02-19', name: 'Tết Nguyên Đán (Mùng 3)', key: 'LUNAR_NEW_YEAR_D3' },
  { date: '2027-02-20', name: 'Tết Nguyên Đán (Mùng 4)', key: 'LUNAR_NEW_YEAR_D4' },
  { date: '2027-02-21', name: 'Tết Nguyên Đán (Mùng 5)', key: 'LUNAR_NEW_YEAR_D5' },
  { date: '2027-04-07', name: 'Giỗ Tổ Hùng Vương', key: 'HUNG_KING_FESTIVAL' },
  { date: '2027-04-30', name: 'Ngày Giải Phóng Miền Nam', key: 'REUNIFICATION_DAY' },
  { date: '2027-05-01', name: 'Ngày Quốc tế Lao Động', key: 'LABOR_DAY' },
  { date: '2027-09-02', name: 'Ngày Quốc Khánh', key: 'INDEPENDENCE_DAY' },
];

@Injectable()
export class VacayService {
  constructor(private prisma: PrismaService) {}

  getHolidays() {
    return VN_HOLIDAYS;
  }

  async getMyDays(userId: string, year?: number) {
    const startDate = year ? new Date(`${year}-01-01`) : new Date('2026-01-01');
    const endDate = year ? new Date(`${year}-12-31`) : new Date('2027-12-31');

    const days = await this.prisma.vacationDay.findMany({
      where: {
        userId,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: 'asc' },
    });

    const leaveDays = days.filter((d) => d.type === 'LEAVE').length;

    return {
      days,
      summary: {
        totalLeave: leaveDays,
        totalHoliday: VN_HOLIDAYS.length,
        remaining: Math.max(0, 12 - leaveDays), // default 12 annual leave
      },
      holidays: VN_HOLIDAYS,
    };
  }

  async addDay(userId: string, dto: CreateVacationDayDto) {
    return this.prisma.vacationDay.upsert({
      where: { userId_date: { userId, date: new Date(dto.date) } },
      create: {
        userId,
        date: new Date(dto.date),
        type: dto.type,
        note: dto.note,
      },
      update: {
        type: dto.type,
        note: dto.note,
      },
    });
  }

  async deleteDay(userId: string, date: string) {
    return this.prisma.vacationDay.deleteMany({
      where: { userId, date: new Date(date) },
    });
  }

  getBridgeSuggestions() {
    // Suggest "cầu" periods - weekends around holidays
    const suggestions: { from: string; to: string; days: number; holidays: string[] }[] = [];
    
    for (const holiday of VN_HOLIDAYS) {
      const hDate = new Date(holiday.date);
      const dayOfWeek = hDate.getDay(); // 0=Sun, 6=Sat
      
      // If holiday is Tuesday or Wednesday, suggest bridging Mon
      if (dayOfWeek === 2) {
        // Tuesday - take Monday off for 4-day weekend
        const mon = new Date(hDate);
        mon.setDate(mon.getDate() - 1);
        const fri = new Date(hDate);
        fri.setDate(fri.getDate() - 3);
        suggestions.push({
          from: fri.toISOString().split('T')[0],
          to: hDate.toISOString().split('T')[0],
          days: 1,
          holidays: [holiday.key],
        });
      } else if (dayOfWeek === 4) {
        // Thursday - take Friday off for 4-day weekend
        const fri = new Date(hDate);
        fri.setDate(fri.getDate() + 1);
        const sun = new Date(hDate);
        sun.setDate(sun.getDate() + 3);
        suggestions.push({
          from: hDate.toISOString().split('T')[0],
          to: sun.toISOString().split('T')[0],
          days: 1,
          holidays: [holiday.key],
        });
      }
    }
    return suggestions;
  }
}
