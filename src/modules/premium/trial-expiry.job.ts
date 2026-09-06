import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TrialService } from './trial.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Dọn các gói và đơn đã quá hạn.
 *
 * Cần nói rõ việc này **không** phải chốt chặn bảo mật: quyền hạn được quyết
 * định bằng cách so `currentPeriodEnd` với hiện tại ở mọi lần kiểm tra, nên
 * dù job này chết hẳn cũng không ai giữ được bản trả phí quá hạn.
 *
 * Nó tồn tại để cột `status` trong bảng khớp với sự thật. Không có nó thì mọi
 * lần dùng thử đã kết thúc vẫn mang `TRIALING` vĩnh viễn, mọi gói hết hạn vẫn
 * mang `ACTIVE`, và mọi câu hỏi kiểu "tháng này bao nhiêu người đang dùng thử"
 * đều trả lời sai.
 *
 * Chạy mỗi giờ chứ không mỗi phút: sai lệch tối đa một giờ trên một cột thống
 * kê là chấp nhận được, còn quét cả bảng mỗi phút thì không.
 */
@Injectable()
export class TrialExpiryJob {
  private readonly logger = new Logger(TrialExpiryJob.name);

  constructor(
    private trials: TrialService,
    private prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'trial-expiry' })
  async run() {
    try {
      const trials = await this.trials.expireDue();

      // Gói đã trả tiền hết hạn: cùng lý do, cùng cách xử lý.
      const subs = await this.prisma.subscription.updateMany({
        where: { status: 'ACTIVE', currentPeriodEnd: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      });

      // Đơn treo quá lâu. `expireStaleOrders` chỉ dọn đơn của chính người vừa
      // bấm mua, nên đơn của người không bao giờ quay lại sẽ nằm `PENDING`
      // mãi và lịch sử thanh toán của họ đầy dòng chờ vô nghĩa.
      const orders = await this.prisma.paymentOrder.updateMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
        },
        data: { status: 'CANCELLED', failureReason: 'EXPIRED' },
      });

      if (trials || subs.count || orders.count) {
        this.logger.log(
          `Dọn hạn: ${trials} lần dùng thử, ${subs.count} gói, ${orders.count} đơn`,
        );
      }
    } catch (e) {
      // Một lần chạy hỏng không được làm sập tiến trình: lần sau vẫn chạy, và
      // quyền hạn thì không phụ thuộc vào việc này.
      this.logger.error(`Dọn hạn thất bại: ${String(e)}`);
    }
  }
}
