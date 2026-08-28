import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ActivitiesModule, PrismaModule],
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
