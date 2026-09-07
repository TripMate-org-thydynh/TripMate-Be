import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Health check cho nền tảng chạy (Render, Docker, load balancer).
   *
   * Có chạm database thật chứ không chỉ trả `{ok: true}`: một tiến trình còn
   * sống nhưng mất kết nối DB thì mọi request đều hỏng, mà health check chỉ
   * đọc bộ nhớ sẽ báo khoẻ và nền tảng cứ thế dồn traffic vào.
   *
   * Cố ý KHÔNG kiểm Redis: cache hỏng thì app vẫn phục vụ được (có fallback
   * in-memory), nên coi đó là "chết" sẽ khiến service bị khởi động lại vô ích.
   */
  @Get('health')
  @ApiOperation({ summary: 'Trạng thái service và kết nối database' })
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up', at: new Date().toISOString() };
    } catch {
      // Ném để nền tảng nhận 5xx — trả 200 kèm `status: 'error'` thì health
      // check của Render vẫn tính là đạt.
      throw new Error('database unreachable');
    }
  }
}
