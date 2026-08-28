import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from '../activities/activities.service';
import { CreateDocumentDto } from './dto/create-document.dto';

@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async getAll(tripId: string) {
    return this.prisma.tripDocument.findMany({
      where: { tripId },
      include: {
        uploader: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(tripId: string, userId: string, dto: CreateDocumentDto) {
    const row = await this.prisma.tripDocument.create({
      data: {
        tripId,
        uploadedBy: userId,
        name: dto.name,
        url: dto.url,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        linkedType: dto.linkedType,
        linkedId: dto.linkedId,
      },
      include: {
        uploader: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    // Ghi nhật ký hoạt động để feed squad có dữ liệu — trước đây
    // ActivitiesService.log() không được gọi ở bất kỳ đâu.
    await this.activities.log(tripId, userId, 'DOCUMENT_UPLOADED', { name: row.name });
    return row;
  }

  /** DELETE is protected by ResourceOwnerGuard at controller level. */
  async delete(documentId: string, userId: string) {
    const doc = await this.prisma.tripDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('errors.database.notFound');
    return this.prisma.tripDocument.delete({ where: { id: documentId } });
  }
}
