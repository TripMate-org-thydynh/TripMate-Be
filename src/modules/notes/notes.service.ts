import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';

@Injectable()
export class NotesService {
  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async getAll(tripId: string) {
    return this.prisma.tripNote.findMany({
      where: { tripId },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(tripId: string, userId: string, dto: CreateNoteDto) {
    const row = await this.prisma.tripNote.create({
      data: {
        tripId,
        authorId: userId,
        title: dto.title,
        content: dto.content,
        color: dto.color ?? '#FFD84D',
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    // Ghi nhật ký hoạt động để feed squad có dữ liệu — trước đây
    // ActivitiesService.log() không được gọi ở bất kỳ đâu.
    await this.activities.log(tripId, userId, 'NOTE_ADDED', { title: row.title ?? '' });
    return row;
  }

  /**
   * Update a note.
   * All fields are content — ownership or trip-creator required.
   */
  async update(noteId: string, userId: string, dto: UpdateNoteDto) {
    const note = await this.prisma.tripNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('errors.database.notFound');
    await this.assertOwnerOrCreator(note.authorId, note.tripId, userId);

    return this.prisma.tripNote.update({
      where: { id: noteId },
      data: {
        title: dto.title,
        content: dto.content,
        color: dto.color,
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async delete(noteId: string, userId: string) {
    const note = await this.prisma.tripNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('errors.database.notFound');
    return this.prisma.tripNote.delete({ where: { id: noteId } });
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
