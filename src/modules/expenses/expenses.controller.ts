import type { User } from '@prisma/client';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { LinkBankDto } from './dto/link-bank.dto';
import { AddCardDto } from './dto/add-card.dto';
import { UpdateBudgetGoalDto } from './dto/update-budget-goal.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
@ApiTags('Expenses')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post()
  @ApiOperation({ summary: 'Ghi nhận chi phí nhóm' })
  create(@Param('tripId') tripId: string, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(tripId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách chi phí chuyến đi' })
  findAll(
    @Param('tripId') tripId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (page || limit) {
      return this.expensesService.findAllPaginated(
        tripId,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 50,
      );
    }
    return this.expensesService.findAll(tripId);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Tính số dư và gợi ý thanh toán tối ưu' })
  getBalances(@Param('tripId') tripId: string) {
    return this.expensesService.getBalances(tripId);
  }

  @Patch(':expenseId/splits/:userId/pay')
  @ApiOperation({ summary: 'Đánh dấu đã hoàn tiền' })
  markPaid(
    @Param('expenseId') expenseId: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: User,
  ) {
    return this.expensesService.markSplitPaid(expenseId, userId, requester.id);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('expense', 'expenseId')
  @Delete(':expenseId')
  @ApiOperation({ summary: 'Xóa chi phí (soft delete)' })
  delete(
    @Param('tripId') tripId: string,
    @Param('expenseId') expenseId: string,
    @CurrentUser() user: User,
  ) {
    return this.expensesService.delete(expenseId, user.id, tripId);
  }

  // --- MODULE 7 ADDITIONAL CONTROLLERS ---

  @Get('wallet')
  @ApiOperation({ summary: 'Lấy ví cá nhân trong chuyến đi' })
  getWallet(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.expensesService.getWallet(tripId, user.id);
  }

  @Get('banks')
  @ApiOperation({ summary: 'Danh sách ngân hàng đã liên kết' })
  getBanks(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.expensesService.getLinkedBanks(user.id);
  }

  @Post('banks')
  @ApiOperation({ summary: 'Liên kết ngân hàng mới' })
  linkBank(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: LinkBankDto,
  ) {
    return this.expensesService.linkBank(user.id, dto);
  }

  @Get('cards')
  @ApiOperation({ summary: 'Danh sách thẻ tín dụng/ghi nợ đã liên kết' })
  getCards(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.expensesService.getPaymentMethods(user.id);
  }

  @Post('cards')
  @ApiOperation({ summary: 'Liên kết thẻ mới' })
  addCard(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: AddCardDto,
  ) {
    return this.expensesService.addPaymentMethod(user.id, dto);
  }

  @Post('ocr')
  @ApiOperation({ summary: 'Quét hóa đơn bằng AI' })
  scanReceipt(
    @Param('tripId') tripId: string,
    @Body('receiptUrl') receiptUrl: string,
  ) {
    return this.expensesService.scanReceipt(receiptUrl);
  }

  @Get('budget-goal')
  @ApiOperation({ summary: 'Lấy hạn mức ngân sách đặt ra cho chuyến đi' })
  getBudgetGoal(@Param('tripId') tripId: string) {
    return this.expensesService.getBudgetGoal(tripId);
  }

  @Post('budget-goal')
  @ApiOperation({ summary: 'Thiết lập/cập nhật hạn mức ngân sách' })
  updateBudgetGoal(
    @Param('tripId') tripId: string,
    @Body() dto: UpdateBudgetGoalDto,
  ) {
    return this.expensesService.updateBudgetGoal(tripId, dto);
  }

  @Get('splitter-game')
  @ApiOperation({ summary: 'Xem trạng thái vòng quay chia hóa đơn' })
  getSplitterGame(@Param('tripId') tripId: string) {
    return this.expensesService.getSplitterGame(tripId);
  }
}
