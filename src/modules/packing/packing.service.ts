import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePackingItemDto } from './dto/create-packing-item.dto';
import { UpdatePackingItemDto } from './dto/update-packing-item.dto';
import { PackingTemplate } from './dto/apply-template.dto';
import { PACKING_TEMPLATES } from './packing.templates';

const ITEM_INCLUDE = {
  assignee: { select: { id: true, name: true, avatarUrl: true } },
  addedByUser: { select: { id: true, name: true, avatarUrl: true } },
};

@Injectable()
export class PackingService {
  constructor(private readonly prisma: PrismaService) {}

  async getList(tripId: string) {
    const items = await this.prisma.packingItem.findMany({
      where: { tripId },
      include: ITEM_INCLUDE,
      orderBy: [{ isPacked: 'asc' }, { createdAt: 'asc' }],
    });
    const packed = items.filter((i) => i.isPacked).length;
    return {
      items,
      progress: {
        total: items.length,
        packed,
        percent:
          items.length === 0 ? 0 : Math.round((packed / items.length) * 100),
      },
    };
  }

  async getListPaginated(tripId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const where = { tripId } as const;

    const [total, items] = await Promise.all([
      this.prisma.packingItem.count({ where }),
      this.prisma.packingItem.findMany({
        where,
        include: ITEM_INCLUDE,
        orderBy: [{ isPacked: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const packed = items.filter((i) => i.isPacked).length;
    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
      progress: {
        total: items.length,
        packed,
        percent:
          items.length === 0 ? 0 : Math.round((packed / items.length) * 100),
      },
    };
  }

  async addItem(tripId: string, userId: string, dto: CreatePackingItemDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    return this.prisma.packingItem.create({
      data: {
        tripId,
        addedBy: userId,
        name: dto.name,
        category: dto.category ?? 'OTHER',
        quantity: dto.quantity ?? 1,
        assignedTo: dto.assignedTo,
      },
      include: ITEM_INCLUDE,
    });
  }

  /**
   * Update a packing item.
   * Toggle isPacked is allowed for any member (group UX).
   * Content changes (name, category, quantity, assignedTo) require ownership
   * or trip-creator role.
   * Supports optimistic concurrency via optional `updatedAt` field.
   */
  async updateItem(itemId: string, userId: string, dto: UpdatePackingItemDto) {
    const item = await this.prisma.packingItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');

    // Optimistic concurrency: if client sends updatedAt, verify it matches DB
    if (dto.updatedAt) {
      const clientDate = new Date(dto.updatedAt).getTime();
      const dbDate = item.updatedAt.getTime();
      if (clientDate !== dbDate) {
        throw new ConflictException('errors.resource.conflict');
      }
    }

    // Determine if this is ONLY a toggle (isPacked) or a content edit
    const isContentChange =
      dto.name !== undefined ||
      dto.category !== undefined ||
      dto.quantity !== undefined ||
      dto.assignedTo !== undefined;

    if (isContentChange) {
      await this.assertOwnerOrCreator(item.addedBy, item.tripId, userId);
    }

    return this.prisma.packingItem.update({
      where: { id: itemId },
      data: {
        name: dto.name ?? undefined,
        category: dto.category ?? undefined,
        quantity: dto.quantity ?? undefined,
        isPacked: dto.isPacked ?? undefined,
        // Cho phép gỡ gán bằng cách gửi assignedTo = null.
        assignedTo: dto.assignedTo === undefined ? undefined : dto.assignedTo,
      },
      include: ITEM_INCLUDE,
    });
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async deleteItem(itemId: string) {
    const item = await this.prisma.packingItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new NotFoundException('Item not found');
    await this.prisma.packingItem.delete({ where: { id: itemId } });
    return { message: 'Item deleted' };
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

  async applyTemplate(
    tripId: string,
    userId: string,
    template: PackingTemplate,
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    const existing = await this.prisma.packingItem.findMany({
      where: { tripId },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((i) => i.name.toLowerCase()));

    const toCreate = PACKING_TEMPLATES[template]
      .filter((t) => !existingNames.has(t.name.toLowerCase()))
      .map((t) => ({
        tripId,
        addedBy: userId,
        name: t.name,
        category: t.category,
        quantity: t.quantity ?? 1,
      }));

    if (toCreate.length > 0) {
      await this.prisma.packingItem.createMany({ data: toCreate });
    }
    return this.getList(tripId);
  }
}
