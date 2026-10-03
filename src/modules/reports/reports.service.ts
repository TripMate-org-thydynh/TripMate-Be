import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ReportReason, ReportStatus, ReportTarget } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { visibleMomentWhere } from '../moments/ghost';

/**
 * Số người báo cáo khác nhau để tự ẩn một mẫu lịch trình công khai trong khi
 * chờ admin xem. Thấp quá thì một nhóm nhỏ dập được mẫu của người khác; cao
 * quá thì nội dung xấu nằm lâu trên kho công khai. 3 là mức chung của nhiều
 * cộng đồng nhỏ — admin mở lại được nếu báo cáo sai.
 */
export const AUTO_HIDE_THRESHOLD = 3;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Gửi báo cáo. Chỉ báo cáo được thứ mình **đang được thấy** — không thì
   * endpoint này thành cách dò xem một id có tồn tại hay không.
   * Gửi lại cùng mục thì cập nhật lý do (không tạo trùng).
   */
  async create(
    reporterId: string,
    targetType: ReportTarget,
    targetId: string,
    reason: ReportReason,
    note?: string,
  ) {
    await this.assertCanSee(reporterId, targetType, targetId);
    if (targetType === 'USER' && targetId === reporterId) {
      throw new ForbiddenException('errors.reports.self');
    }

    const report = await this.prisma.contentReport.upsert({
      where: {
        reporterId_targetType_targetId: { reporterId, targetType, targetId },
      },
      create: { reporterId, targetType, targetId, reason, note },
      update: { reason, note, status: 'OPEN', resolvedAt: null },
      select: { id: true, status: true },
    });

    let hidden = false;
    if (targetType === 'TEMPLATE') hidden = await this.maybeAutoHide(targetId);
    return { id: report.id, status: report.status, hidden };
  }

  private async maybeAutoHide(templateId: string) {
    const open = await this.prisma.contentReport.count({
      where: { targetType: 'TEMPLATE', targetId: templateId, status: 'OPEN' },
    });
    if (open < AUTO_HIDE_THRESHOLD) return false;
    const r = await this.prisma.itineraryTemplate.updateMany({
      where: { id: templateId, isPublic: true },
      data: { isPublic: false },
    });
    if (r.count) {
      this.logger.warn(`Tự ẩn mẫu ${templateId} sau ${open} báo cáo`);
    }
    return true;
  }

  private async assertCanSee(
    userId: string,
    type: ReportTarget,
    id: string,
  ): Promise<void> {
    let ok = 0;
    switch (type) {
      case 'TEMPLATE':
        ok = await this.prisma.itineraryTemplate.count({
          where: {
            id,
            deletedAt: null,
            OR: [{ isPublic: true }, { authorId: userId }],
          },
        });
        break;
      case 'MOMENT':
        ok = await this.prisma.moment.count({
          where: {
            id,
            deletedAt: null,
            trip: { members: { some: { userId } } },
            ...visibleMomentWhere(userId),
          },
        });
        break;
      case 'CHAT_MESSAGE':
        ok = await this.prisma.chatMessage.count({
          where: { id, trip: { members: { some: { userId } } } },
        });
        break;
      case 'USER':
        ok = await this.prisma.user.count({ where: { id, deletedAt: null } });
        break;
    }
    if (!ok) throw new NotFoundException('errors.database.notFound');
  }

  // ── Admin ──────────────────────────────────────────────────────────────
  list(status: ReportStatus = 'OPEN', take = 50) {
    return this.prisma.contentReport.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
      include: { reporter: { select: { id: true, name: true } } },
    });
  }

  /**
   * Admin chốt một báo cáo. `hide` = gỡ nội dung (mẫu: thôi công khai;
   * khoảnh khắc: xoá mềm). Mọi báo cáo OPEN cùng mục được đóng theo.
   */
  async resolve(id: string, decision: 'RESOLVED' | 'DISMISSED', hide: boolean) {
    const report = await this.prisma.contentReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('errors.database.notFound');
    const { targetType, targetId } = report;

    if (hide && decision === 'RESOLVED') {
      if (targetType === 'TEMPLATE') {
        await this.prisma.itineraryTemplate.updateMany({
          where: { id: targetId },
          data: { isPublic: false },
        });
      } else if (targetType === 'MOMENT') {
        await this.prisma.moment.updateMany({
          where: { id: targetId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
    }
    // Bác báo cáo về mẫu đã bị tự ẩn → mở lại công khai.
    if (decision === 'DISMISSED' && targetType === 'TEMPLATE') {
      await this.prisma.itineraryTemplate.updateMany({
        where: { id: targetId, deletedAt: null },
        data: { isPublic: true },
      });
    }

    const closed = await this.prisma.contentReport.updateMany({
      where: { targetType, targetId, status: 'OPEN' },
      data: { status: decision, resolvedAt: new Date() },
    });
    return { closed: closed.count };
  }
}
