import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateJournalEntryDto, UpdateJournalEntryDto } from './dto/journal.dto';

@Injectable()
export class JournalService {
  constructor(private prisma: PrismaService) {}

  async getAll(tripId: string) {
    return this.prisma.journalEntry.findMany({
      where: { tripId },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        photos: true,
      },
      orderBy: { entryDate: 'desc' },
    });
  }

  async getOne(entryId: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        photos: true,
      },
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    return entry;
  }

  async create(tripId: string, userId: string, dto: CreateJournalEntryDto) {
    return this.prisma.journalEntry.create({
      data: {
        tripId,
        authorId: userId,
        title: dto.title,
        body: dto.body,
        mood: dto.mood,
        entryDate: new Date(dto.entryDate),
        latitude: dto.latitude,
        longitude: dto.longitude,
        photos: dto.photos
          ? {
              create: dto.photos.map((p) => ({
                mediaUrl: p.mediaUrl,
                caption: p.caption,
              })),
            }
          : undefined,
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        photos: true,
      },
    });
  }

  /**
   * Update a journal entry.
   * All fields are content — ownership or trip-creator required.
   */
  async update(entryId: string, userId: string, dto: UpdateJournalEntryDto) {
    const entry = await this.prisma.journalEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('errors.database.notFound');
    await this.assertOwnerOrCreator(entry.authorId, entry.tripId, userId);

    return this.prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        title: dto.title,
        body: dto.body,
        mood: dto.mood,
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        photos: true,
      },
    });
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async delete(entryId: string, userId: string) {
    const entry = await this.prisma.journalEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new NotFoundException('errors.database.notFound');
    return this.prisma.journalEntry.delete({ where: { id: entryId } });
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
