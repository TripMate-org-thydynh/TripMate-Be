import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { MomentsController } from './moments.controller';
import { MomentsService } from './moments.service';

@Module({ imports: [ActivitiesModule], controllers: [MomentsController], providers: [MomentsService] })
export class MomentsModule {}
