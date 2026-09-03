import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { PollsController } from './polls.controller';
import { PollsService } from './polls.service';

@Module({
  imports: [ActivitiesModule],
  controllers: [PollsController],
  providers: [PollsService],
})
export class PollsModule {}
