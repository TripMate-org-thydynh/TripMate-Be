import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Hash mật khẩu không bao giờ rời khỏi DB trừ khi truy vấn xin đích danh
    // (`omit: { passwordHash: false }` ở chỗ đăng nhập). Chặn tại một chỗ để
    // mọi `findUnique`/`include: { user: true }` hiện tại và sau này đều an
    // toàn, thay vì trông vào từng `select`.
    super({ omit: { user: { passwordHash: true } } });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
