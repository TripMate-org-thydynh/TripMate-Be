import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import {
  AssignReceiptLineDto, CreateReceiptDraftDto, EditReceiptLineDto,
  ReceiptLineDto, ReceiptRevisionDto, UpdateReceiptDetailsDto,
} from './dto/receipt-draft.dto';
import { ReceiptDraftsService } from './receipt-drafts.service';
import { RequireCapability } from '../health/capability.guard';

@UseGuards(JwtAuthGuard, TripMemberGuard)
@Controller('trips/:tripId/receipt-drafts')
@RequireCapability('receiptDrafts')
export class ReceiptDraftsController {
  constructor(private readonly drafts: ReceiptDraftsService) {}

  @Get()
  @RequireCapability('receiptDrafts', false)
  list(@Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.drafts.list(tripId);
  }

  @Post()
  create(@Param('tripId', ParseUUIDPipe) tripId: string, @CurrentUser() user: User, @Body() dto: CreateReceiptDraftDto) {
    return this.drafts.create(tripId, user.id, dto);
  }

  @Get(':id')
  @RequireCapability('receiptDrafts', false)
  get(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.drafts.get(tripId, id);
  }

  @Patch(':id')
  update(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User, @Body() dto: UpdateReceiptDetailsDto) {
    return this.drafts.update(tripId, id, user.id, dto);
  }

  @Post(':id/lines')
  addLine(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User, @Body() dto: ReceiptLineDto) {
    return this.drafts.addLine(tripId, id, user.id, dto);
  }

  @Patch(':id/lines/:lineId')
  editLine(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string, @CurrentUser() user: User, @Body() dto: EditReceiptLineDto) {
    return this.drafts.editLine(tripId, id, lineId, user.id, dto);
  }

  @Delete(':id/lines/:lineId')
  removeLine(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string, @CurrentUser() user: User, @Query() dto: ReceiptRevisionDto) {
    return this.drafts.removeLine(tripId, id, lineId, user.id, dto.version);
  }

  @Put(':id/lines/:lineId/assignment')
  assign(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string, @CurrentUser() user: User, @Body() dto: AssignReceiptLineDto) {
    return this.drafts.assign(tripId, id, lineId, user.id, dto);
  }

  @Post(':id/finalize')
  finalize(@Param('tripId', ParseUUIDPipe) tripId: string, @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User, @Body() dto: ReceiptRevisionDto) {
    return this.drafts.finalize(tripId, id, user.id, dto.version);
  }
}
