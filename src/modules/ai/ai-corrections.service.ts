import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bộ nhớ đính chính: quán đóng cửa, đổi địa chỉ, tăng giá vé.
 *
 * Địa điểm du lịch đổi liên tục. Sửa bằng cách chèn một dòng đính chính vào
 * prompt rẻ hơn nhiều so với đánh chỉ mục lại kho tri thức, và có hiệu lực
 * ngay lập tức.
 *
 * **Chỉ bản ghi đã duyệt** mới được chèn. Nếu ai gửi gì cũng vào thì người
 * dùng có thể đầu độc câu trả lời cho tất cả những người khác — đây là lỗ
 * hổng quan trọng nhất của mô hình này, nên duyệt là bắt buộc chứ không phải
 * tuỳ chọn.
 */
@Injectable()
export class AiCorrectionsService {
  private readonly logger = new Logger(AiCorrectionsService.name);

  /** Chèn tối đa ngần này dòng để prompt không phình ra vô hạn. */
  private static readonly MAX_INJECTED = 5;

  constructor(private readonly prisma: PrismaService) {}

  async submit(userId: string, subject: string, correction: string) {
    return this.prisma.aiCorrection.create({
      data: {
        subject: subject.trim().slice(0, 200),
        correction: correction.trim().slice(0, 500),
        createdById: userId,
        isApproved: false,
      },
    });
  }

  async approve(id: string, approved: boolean) {
    const row = await this.prisma.aiCorrection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy đính chính');
    return this.prisma.aiCorrection.update({
      where: { id },
      data: { isApproved: approved, approvedAt: approved ? new Date() : null },
    });
  }

  async listPending(limit = 50) {
    return this.prisma.aiCorrection.findMany({
      where: { isApproved: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Các dòng đính chính liên quan tới [prompt], đã sẵn sàng chèn vào prompt.
   *
   * Khớp bằng cách dò tên chủ thể xuất hiện trong câu hỏi. Thô nhưng đủ: chủ
   * thể là tên riêng ("Quán Lẩu Bò Ba Toa"), mà tên riêng thì hiếm khi trùng.
   * Lỗi truy vấn không được làm hỏng câu trả lời nên nuốt và trả rỗng.
   */
  async relevantTo(prompt: string): Promise<string[]> {
    const hay = (prompt ?? '').toLowerCase();
    if (!hay) return [];
    try {
      const rows = await this.prisma.aiCorrection.findMany({
        where: { isApproved: true },
        orderBy: { approvedAt: 'desc' },
        take: 200,
      });
      return rows
        .filter((r) => hay.includes(r.subject.toLowerCase()))
        .slice(0, AiCorrectionsService.MAX_INJECTED)
        .map((r) => `- ${r.subject}: ${r.correction}`);
    } catch (e) {
      this.logger.warn(`Không đọc được đính chính: ${(e as Error).message}`);
      return [];
    }
  }

  /** Khối chữ chèn vào prompt, hoặc chuỗi rỗng khi không có gì liên quan. */
  async promptBlock(prompt: string): Promise<string> {
    const lines = await this.relevantTo(prompt);
    if (lines.length === 0) return '';
    return [
      '',
      'THÔNG TIN ĐÃ ĐÍNH CHÍNH (ưu tiên hơn kiến thức sẵn có của bạn):',
      ...lines,
      '',
    ].join('\n');
  }
}
