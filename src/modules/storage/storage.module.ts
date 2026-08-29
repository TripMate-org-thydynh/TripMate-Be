import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
