import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminReportsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PrismaModule],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
