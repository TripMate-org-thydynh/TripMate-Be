import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { AiModule } from '../ai/ai.module';
import { ReceiptDraftsController } from './receipt-drafts.controller';
import { ReceiptDraftsService } from './receipt-drafts.service';

@Module({
  imports: [ActivitiesModule, AiModule],
  controllers: [ExpensesController, ReceiptDraftsController],
  providers: [ExpensesService, ReceiptDraftsService],
})
export class ExpensesModule {}
