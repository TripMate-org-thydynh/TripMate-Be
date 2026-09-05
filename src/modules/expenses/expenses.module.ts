import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [ActivitiesModule, AiModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
