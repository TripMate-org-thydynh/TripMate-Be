import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { AiService, ParsedReservation } from '../ai/ai.service';
import type { ReservationType } from '@prisma/client';

const INCLUDE = {
  addedByUser: { select: { id: true, name: true, avatarUrl: true } },
};

/**
 * Map loại đặt chỗ sang ExpenseCategory phù hợp để auto-tạo expense.
 */
const RESERVATION_TYPE_TO_CATEGORY: Record<string, string> = {
  FLIGHT: 'TRANSPORT',
  TRAIN: 'TRANSPORT',
  BUS: 'TRANSPORT',
  CAR: 'TRANSPORT',
  HOTEL: 'ACCOMMODATION',
  RESTAURANT: 'FOOD',
  EVENT: 'ENTERTAINMENT',
  ATTRACTION: 'ACTIVITIES',
  OTHER: 'OTHER',
};

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Booking-import: dán text xác nhận → AI bóc tách → tạo đặt chỗ.
   * Nếu đặt chỗ nào có price > 0, tự động tạo expense tương ứng.
   * Trả về { created, items, expensesCreated } để client biết.
   */
  async importFromText(tripId: string, userId: string, text: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    const parsed = await this.ai.parseBookingText(text);
    if (parsed.length === 0) {
      return { created: 0, items: [], expensesCreated: 0 };
    }

    return this._persistParsed(tripId, userId, parsed);
  }

  /**
   * Booking-import từ ảnh/PDF: Gemini vision bóc tách → tạo đặt chỗ.
   * Nếu đặt chỗ có price > 0, tự động tạo expense tương ứng.
   */
  async importFromImage(
    tripId: string,
    userId: string,
    imageBase64: string,
    mimeType: string,
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    const parsed = await this.ai.parseBookingImage(imageBase64, mimeType);
    if (parsed.length === 0) {
      return { created: 0, items: [], expensesCreated: 0 };
    }

    return this._persistParsed(tripId, userId, parsed);
  }

  /**
   * Tạo reservation records + auto-expense nếu có giá.
   */
  private async _persistParsed(
    tripId: string,
    userId: string,
    parsed: ParsedReservation[],
  ) {
    // Tạo các reservation
    await this.prisma.reservation.createMany({
      data: parsed.map((p) => ({
        tripId,
        addedBy: userId,
        type: p.type,
        title: p.title,
        location: p.location ?? undefined,
        confirmationNumber: p.confirmationNumber ?? undefined,
        notes: p.notes ?? undefined,
        price: p.price ?? undefined,
        startTime: this.safeDate(p.startTime),
        endTime: this.safeDate(p.endTime),
      })),
    });

    // Auto-tạo expense cho các item có price > 0
    const withPrice = parsed.filter(
      (p) => typeof p.price === 'number' && p.price > 0,
    );
    let expensesCreated = 0;

    for (const p of withPrice) {
      await this.autoCreateExpense(
        tripId,
        userId,
        p.type,
        p.title,
        p.price!,
      );
      expensesCreated++;
    }

    const items = await this.list(tripId);
    return { created: parsed.length, items, expensesCreated };
  }

  /**
   * Tự tạo 1 expense EQUAL-split cho cả nhóm từ 1 đặt chỗ có giá.
   * Dùng chung cho import (AI) và tạo thủ công. Không throw để không chặn
   * việc tạo reservation nếu expense lỗi.
   */
  private async autoCreateExpense(
    tripId: string,
    userId: string,
    type: string,
    title: string,
    price: number,
  ): Promise<boolean> {
    try {
      const members = await this.prisma.tripMember.findMany({
        where: { tripId },
        select: { userId: true },
      });
      const category = RESERVATION_TYPE_TO_CATEGORY[type] ?? 'OTHER';
      const memberCount = members.length || 1;
      const perPerson = +(price / memberCount).toFixed(2);

      await this.prisma.expense.create({
        data: {
          tripId,
          paidById: userId,
          amount: price,
          category: category as any,
          description: `[Auto] ${title}`,
          splitType: 'EQUAL',
          splits: {
            create: members.map((m) => ({
              userId: m.userId,
              shareAmount: perPerson,
              isPaid: m.userId === userId,
              paidAt: m.userId === userId ? new Date() : null,
            })),
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private safeDate(iso: string | null): Date | undefined {
    if (!iso) return undefined;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? undefined : d;
  }

  list(tripId: string) {
    return this.prisma.reservation.findMany({
      where: { tripId },
      include: INCLUDE,
      // Chưa có giờ thì xếp cuối (nulls last mô phỏng bằng thứ tự phụ createdAt).
      orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Feed liên chuyến: vé/booking sắp tới của user (widget dashboard, giống TREK). */
  async listUpcoming(userId: string, limit = 6) {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) return [];

    return this.prisma.reservation.findMany({
      where: {
        tripId: { in: tripIds },
        startTime: { gte: new Date() },
        status: { not: 'CANCELLED' },
      },
      include: {
        ...INCLUDE,
        trip: { select: { id: true, name: true } },
      },
      orderBy: { startTime: 'asc' },
      take: limit,
    });
  }

  async create(tripId: string, userId: string, dto: CreateReservationDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    const reservation = await this.prisma.reservation.create({
      data: {
        tripId,
        addedBy: userId,
        type: dto.type,
        title: dto.title.trim(),
        location: dto.location,
        confirmationNumber: dto.confirmationNumber,
        url: dto.url,
        notes: dto.notes,
        status: dto.status ?? 'CONFIRMED',
        price: dto.price,
        startTime: dto.startTime ? new Date(dto.startTime) : null,
        endTime: dto.endTime ? new Date(dto.endTime) : null,
      },
      include: INCLUDE,
    });

    // Có giá → tự tạo expense chia đều cho nhóm (giống import).
    let expenseCreated = false;
    if (typeof dto.price === 'number' && dto.price > 0) {
      expenseCreated = await this.autoCreateExpense(
        tripId,
        userId,
        dto.type,
        reservation.title,
        dto.price,
      );
    }

    return { ...reservation, expenseCreated };
  }

  /**
   * Update a reservation.
   * Status toggle is allowed for any member (group UX).
   * Content changes (type, title, location, etc.) require ownership or trip-creator.
   */
  async update(itemId: string, userId: string, dto: UpdateReservationDto) {
    const item = await this.prisma.reservation.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('errors.database.notFound');

    // Determine if this is ONLY a status toggle or a content edit
    const isContentChange =
      dto.type !== undefined ||
      dto.title !== undefined ||
      dto.location !== undefined ||
      dto.confirmationNumber !== undefined ||
      dto.url !== undefined ||
      dto.notes !== undefined ||
      dto.price !== undefined ||
      dto.startTime !== undefined ||
      dto.endTime !== undefined;

    if (isContentChange) {
      await this.assertOwnerOrCreator(item.addedBy, item.tripId, userId);
    }

    return this.prisma.reservation.update({
      where: { id: itemId },
      data: {
        type: dto.type,
        title: dto.title?.trim() ?? undefined,
        location: dto.location ?? undefined,
        confirmationNumber: dto.confirmationNumber ?? undefined,
        url: dto.url ?? undefined,
        notes: dto.notes ?? undefined,
        status: dto.status ?? undefined,
        price: dto.price ?? undefined,
        startTime:
          dto.startTime === undefined ? undefined : new Date(dto.startTime),
        endTime: dto.endTime === undefined ? undefined : new Date(dto.endTime),
      },
      include: INCLUDE,
    });
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async remove(itemId: string, userId: string) {
    const item = await this.prisma.reservation.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('errors.database.notFound');
    await this.prisma.reservation.delete({ where: { id: itemId } });
    return { message: 'Reservation deleted' };
  }

  /** Throws 403 unless userId is the resource owner or trip creator. */
  private async assertOwnerOrCreator(
    ownerId: string,
    tripId: string,
    userId: string,
  ): Promise<void> {
    if (ownerId === userId) return;
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { createdBy: true },
    });
    if (trip && trip.createdBy === userId) return;
    throw new ForbiddenException('errors.auth.notOwner');
  }
}
