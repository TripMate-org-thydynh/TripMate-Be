import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ActivitiesModule, PrismaModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
