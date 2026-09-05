import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ActivitiesModule, PrismaModule],
  controllers: [JournalController],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
