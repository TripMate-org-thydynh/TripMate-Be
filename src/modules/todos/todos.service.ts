import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';

const INCLUDE = {
  assignee: { select: { id: true, name: true, avatarUrl: true } },
  addedByUser: { select: { id: true, name: true, avatarUrl: true } },
};

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}

  async getList(tripId: string) {
    const items = await this.prisma.todoItem.findMany({
      where: { tripId },
      include: INCLUDE,
      orderBy: [{ isDone: 'asc' }, { createdAt: 'asc' }],
    });
    const done = items.filter((i) => i.isDone).length;
    return {
      items,
      progress: {
        total: items.length,
        done,
        percent: items.length === 0 ? 0 : Math.round((done / items.length) * 100),
      },
    };
  }

  async getListPaginated(tripId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const where = { tripId } as const;

    const [total, items] = await Promise.all([
      this.prisma.todoItem.count({ where }),
      this.prisma.todoItem.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ isDone: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const done = items.filter((i) => i.isDone).length;
    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
      progress: {
        total: items.length,
        done,
        percent: items.length === 0 ? 0 : Math.round((done / items.length) * 100),
      },
    };
  }

  async addItem(tripId: string, userId: string, dto: CreateTodoDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    return this.prisma.todoItem.create({
      data: {
        tripId,
        addedBy: userId,
        title: dto.title.trim(),
        priority: dto.priority ?? 'NORMAL',
        assignedTo: dto.assignedTo,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      },
      include: INCLUDE,
    });
  }

  /**
   * Update a todo item.
   * Toggle isDone is allowed for any member (group UX).
   * Content changes (title, priority, assignedTo, dueDate) require ownership
   * or trip-creator role.
   * Supports optimistic concurrency via optional `updatedAt` field.
   */
  async updateItem(itemId: string, userId: string, dto: UpdateTodoDto) {
    const item = await this.prisma.todoItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Todo not found');

    // Optimistic concurrency: if client sends updatedAt, verify it matches DB
    if (dto.updatedAt) {
      const clientDate = new Date(dto.updatedAt).getTime();
      const dbDate = item.updatedAt.getTime();
      if (clientDate !== dbDate) {
        throw new ConflictException('errors.resource.conflict');
      }
    }

    // Determine if this is ONLY a toggle (isDone) or a content edit
    const isContentChange =
      dto.title !== undefined ||
      dto.priority !== undefined ||
      dto.assignedTo !== undefined ||
      dto.dueDate !== undefined;

    if (isContentChange) {
      await this.assertOwnerOrCreator(item.addedBy, item.tripId, userId);
    }

    return this.prisma.todoItem.update({
      where: { id: itemId },
      data: {
        title: dto.title?.trim() ?? undefined,
        priority: dto.priority ?? undefined,
        isDone: dto.isDone ?? undefined,
        assignedTo: dto.assignedTo === undefined ? undefined : dto.assignedTo,
        dueDate:
          dto.dueDate === undefined
            ? undefined
            : dto.dueDate === null
              ? null
              : new Date(dto.dueDate),
      },
      include: INCLUDE,
    });
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async deleteItem(itemId: string) {
    const item = await this.prisma.todoItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Todo not found');
    await this.prisma.todoItem.delete({ where: { id: itemId } });
    return { message: 'Todo deleted' };
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
