import { Module } from '@nestjs/common';
import { VacayController } from './vacay.controller';
import { VacayService } from './vacay.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [VacayController],
  providers: [VacayService],
  exports: [VacayService],
})
export class VacayModule {}
