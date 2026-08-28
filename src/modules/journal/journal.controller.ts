import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JournalService } from './journal.service';
import { CreateJournalEntryDto, UpdateJournalEntryDto } from './dto/journal.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Journal')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/journal')
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  @Get()
  @ApiOperation({ summary: 'Nhật ký du lịch của chuyến' })
  getAll(@Param('tripId') tripId: string) {
    return this.journalService.getAll(tripId);
  }

  @Get(':entryId')
  @ApiOperation({ summary: 'Chi tiết nhật ký entry' })
  getOne(@Param('entryId') entryId: string) {
    return this.journalService.getOne(entryId);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo nhật ký mới' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.journalService.create(tripId, user.id, dto);
  }

  @Patch(':entryId')
  @ApiOperation({ summary: 'Cập nhật nhật ký' })
  update(
    @Param('entryId') entryId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateJournalEntryDto,
  ) {
    return this.journalService.update(entryId, user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('journalEntry', 'entryId')
  @Delete(':entryId')
  @ApiOperation({ summary: 'Xóa nhật ký' })
  delete(@Param('entryId') entryId: string, @CurrentUser() user: User) {
    return this.journalService.delete(entryId, user.id);
  }
}
