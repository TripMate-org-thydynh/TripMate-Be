import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StoreService } from './store.service';
import { XpController } from './xp.controller';
import { XpService } from './xp.service';

/**
 * Global vì rất nhiều module cần cộng XP (moments, expenses, games...).
 * Đánh dấu global tránh phải import vào từng module một.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [XpController],
  providers: [XpService, StoreService],
  exports: [XpService, StoreService],
})
export class XpModule {}
