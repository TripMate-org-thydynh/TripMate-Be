import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  Logger, NotFoundException,
} from '@nestjs/common';
import { Prisma, ReceiptDraft } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssignReceiptLineDto, CreateReceiptDraftDto, EditReceiptLineDto,
  ReceiptDetailsDto, ReceiptLineDto, UpdateReceiptDetailsDto,
} from './dto/receipt-draft.dto';
import { ExpensesService } from './expenses.service';
import { allocateReceipt } from './receipt-allocation';

const include = { lines: { orderBy: { position: 'asc' } } } as const;
type WithLines = Prisma.ReceiptDraftGetPayload<{ include: typeof include }>;

@Injectable()
export class ReceiptDraftsService {
  private readonly logger = new Logger(ReceiptDraftsService.name);

  constructor(private readonly prisma: PrismaService, private readonly expenses: ExpensesService) {}

  private details(dto: ReceiptDetailsDto) {
    return {
      title: dto.title.trim(),
      total: BigInt(dto.total),
      tax: BigInt(dto.tax ?? 0),
      fee: BigInt(dto.fee ?? 0),
      discount: BigInt(dto.discount ?? 0),
    };
  }

  private summary(draft: ReceiptDraft) {
    return { ...draft, total: Number(draft.total), tax: Number(draft.tax),
      fee: Number(draft.fee), discount: Number(draft.discount) };
  }

  private allocation(draft: WithLines) {
    return allocateReceipt(draft.total, draft.tax + draft.fee - draft.discount, draft.lines);
  }

  private view(draft: WithLines) {
    return { ...this.summary(draft), lines: draft.lines.map(line => ({
      ...line, amount: Number(line.amount),
    })), allocation: this.allocation(draft) };
  }

  async list(tripId: string) {
    const drafts = await this.prisma.receiptDraft.findMany({
      where: { tripId, finalizedAt: null }, orderBy: { createdAt: 'desc' }, take: 30,
    });
    return drafts.map(draft => this.summary(draft));
  }

  async get(tripId: string, id: string) {
    const draft = await this.prisma.receiptDraft.findFirst({ where: { tripId, id }, include });
    if (!draft) throw new NotFoundException();
    return this.view(draft);
  }

  async create(tripId: string, userId: string, dto: CreateReceiptDraftDto) {
    return this.prisma.$transaction(async tx => {
      const [trip] = await tx.$queryRaw<{ currency: string }[]>`
        SELECT currency FROM trips WHERE id = ${tripId}::uuid AND deleted_at IS NULL FOR SHARE
      `;
      if (!trip || trip.currency !== 'VND') throw new BadRequestException('RECEIPT_REQUIRES_VND');
      const members = await this.memberIds(tx, tripId);
      if (!members.has(userId)) throw new ForbiddenException();
      const { count } = await tx.receiptDraft.createMany({
        data: { ...this.details(dto), id: dto.id, tripId, creatorId: userId }, skipDuplicates: true,
      });
      if (count) await tx.receiptLine.createMany({ data: dto.lines.map((line, position) => ({
        draftId: dto.id, name: line.name.trim(), amount: BigInt(line.amount), position,
      })) });
      const recipients = [...members].filter(member => member !== userId);
      if (count && recipients.length) await tx.notification.createMany({
        data: recipients.map(member => ({
          userId: member, tripId, title: 'Chọn món trên bill', body: dto.title.trim(),
          type: 'TRIP_UPDATE', data: { receiptDraftId: dto.id },
        })),
      });
      const draft = await tx.receiptDraft.findFirst({ where: { id: dto.id, tripId, creatorId: userId }, include });
      if (!draft) throw new ConflictException('RECEIPT_ID_IN_USE');
      return this.view(draft);
    });
  }

  private async lock(tx: Prisma.TransactionClient, tripId: string, id: string) {
    const rows = await tx.$queryRaw<unknown[]>`
      SELECT id FROM receipt_drafts WHERE id = ${id}::uuid AND trip_id = ${tripId}::uuid FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException();
    return tx.receiptDraft.findUniqueOrThrow({ where: { id }, include });
  }

  private assertEditable(draft: ReceiptDraft, userId?: string) {
    if (userId && draft.creatorId !== userId) throw new ForbiddenException();
    if (draft.finalizedAt) throw new ConflictException('RECEIPT_FINALIZED');
  }

  private assertRevision(version: number, requested: number) {
    if (version !== requested) throw new ConflictException('RECEIPT_VERSION_CHANGED');
  }

  private async afterEdit(tx: Prisma.TransactionClient, id: string) {
    return this.view(await tx.receiptDraft.update({
      where: { id }, data: { version: { increment: 1 } }, include,
    }));
  }

  async update(tripId: string, id: string, userId: string, dto: UpdateReceiptDetailsDto) {
    return this.prisma.$transaction(async tx => {
      const draft = await this.lock(tx, tripId, id);
      this.assertEditable(draft, userId);
      this.assertRevision(draft.version, dto.version);
      return this.view(await tx.receiptDraft.update({
        where: { id }, data: { ...this.details(dto), version: { increment: 1 } }, include,
      }));
    });
  }

  async addLine(tripId: string, id: string, userId: string, dto: ReceiptLineDto) {
    return this.prisma.$transaction(async tx => {
      const draft = await this.lock(tx, tripId, id);
      this.assertEditable(draft, userId);
      if (draft.lines.length >= 100) throw new BadRequestException('RECEIPT_LINE_LIMIT');
      await tx.receiptLine.create({ data: {
        draftId: id, name: dto.name.trim(), amount: BigInt(dto.amount),
        position: (draft.lines.at(-1)?.position ?? -1) + 1,
      } });
      return this.afterEdit(tx, id);
    });
  }

  async editLine(tripId: string, id: string, lineId: string, userId: string, dto: EditReceiptLineDto) {
    return this.prisma.$transaction(async tx => {
      const draft = await this.lock(tx, tripId, id);
      this.assertEditable(draft, userId);
      const line = draft.lines.find(record => record.id === lineId);
      if (!line) throw new NotFoundException();
      this.assertRevision(line.version, dto.version);
      if (line.assigneeIds.length) throw new ConflictException('RECEIPT_LINE_ASSIGNED');
      await tx.receiptLine.update({
        where: { id: lineId }, data: {
          name: dto.name.trim(), amount: BigInt(dto.amount), version: { increment: 1 },
        },
      });
      return this.afterEdit(tx, id);
    });
  }

  async removeLine(tripId: string, id: string, lineId: string, userId: string, version: number) {
    return this.prisma.$transaction(async tx => {
      const draft = await this.lock(tx, tripId, id);
      this.assertEditable(draft, userId);
      const line = draft.lines.find(record => record.id === lineId);
      if (!line) throw new NotFoundException();
      this.assertRevision(line.version, version);
      if (line.assigneeIds.length) throw new ConflictException('RECEIPT_LINE_ASSIGNED');
      await tx.receiptLine.delete({ where: { id: lineId } });
      return this.afterEdit(tx, id);
    });
  }

  private async memberIds(tx: Prisma.TransactionClient, tripId: string) {
    const members = await tx.$queryRaw<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM trip_members WHERE trip_id = ${tripId}::uuid FOR KEY SHARE
    `;
    return new Set(members.map(({ userId }) => userId));
  }

  async assign(tripId: string, id: string, lineId: string, userId: string, dto: AssignReceiptLineDto) {
    return this.prisma.$transaction(async tx => {
      const draft = await this.lock(tx, tripId, id);
      this.assertEditable(draft);
      const line = draft.lines.find(record => record.id === lineId);
      if (!line) throw new NotFoundException();
      this.assertRevision(line.version, dto.version);
      const members = await this.memberIds(tx, tripId);
      if (!members.has(userId)) throw new ForbiddenException();
      if (dto.assigneeIds.some(id => !members.has(id))) throw new BadRequestException('RECEIPT_UNKNOWN_MEMBER');
      if (line.assigneeIds.length && userId !== draft.creatorId && userId !== line.assignedById) {
        if (!line.assigneeIds.includes(userId)) throw new ConflictException('RECEIPT_LINE_ASSIGNED');
        const others = (ids: string[]) => ids.filter(id => id !== userId).sort().join(',');
        if (others(line.assigneeIds) !== others(dto.assigneeIds)) throw new ForbiddenException();
      }
      await tx.receiptLine.update({ where: { id: lineId }, data: {
        assigneeIds: dto.assigneeIds, assignedById: dto.assigneeIds.length ? userId : null,
        version: { increment: 1 },
      } });
      return this.afterEdit(tx, id);
    });
  }

  async finalize(tripId: string, id: string, userId: string, version: number) {
    const draft = await this.prisma.$transaction(async tx => {
      const current = await this.lock(tx, tripId, id);
      if (current.creatorId !== userId) throw new ForbiddenException();
      if (current.finalizedAt) return current;
      this.assertRevision(current.version, version);
      const [trip] = await tx.$queryRaw<{ currency: string }[]>`
        SELECT currency FROM trips WHERE id = ${tripId}::uuid AND deleted_at IS NULL FOR SHARE
      `;
      if (!trip || trip.currency !== 'VND') throw new BadRequestException('RECEIPT_REQUIRES_VND');
      const members = await this.memberIds(tx, tripId);
      if (!members.has(userId)) throw new ForbiddenException();
      if (current.lines.some(line => line.assigneeIds.some(member => !members.has(member)))) {
        throw new ConflictException('RECEIPT_MEMBER_LEFT');
      }
      const allocation = this.allocation(current);
      if (!allocation.complete) throw new BadRequestException('RECEIPT_UNBALANCED');
      const finalizedAt = new Date();
      const expense = await tx.expense.create({
        data: {
          tripId, paidById: userId, amount: current.total.toString(),
          category: 'FOOD', description: current.title, splitType: 'EXACT',
          splits: { create: allocation.shares.map(({ userId: member, amount }) => ({
            userId: member, shareAmount: amount, isPaid: member === userId,
            paidAt: member === userId ? finalizedAt : null,
          })) },
        },
      });
      return tx.receiptDraft.update({
        where: { id }, data: { expenseId: expense.id, finalizedAt, version: { increment: 1 } }, include,
      });
    });
    try {
      await this.expenses.evictCache(tripId);
    } catch (error) {
      this.logger.warn('Could not invalidate expense cache after receipt finalization', error);
    }
    return this.view(draft);
  }
}
