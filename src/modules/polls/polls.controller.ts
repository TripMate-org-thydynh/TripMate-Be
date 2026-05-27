import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PollsService } from './polls.service';
import { CreatePollDto } from './dto/create-poll.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Polls')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/polls')
export class PollsController {
  constructor(private readonly pollsService: PollsService) {}

  @Post()
  @ApiOperation({ summary: 'Tạo poll bình chọn nhóm' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: any,
    @Body() dto: CreatePollDto,
  ) {
    return this.pollsService.create(tripId, user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách polls của chuyến đi' })
  findAll(@Param('tripId') tripId: string) {
    return this.pollsService.findAll(tripId);
  }

  @Post('options/:optionId/vote')
  @ApiOperation({ summary: 'Bỏ phiếu / rút phiếu (toggle)' })
  vote(@Param('optionId') optionId: string, @CurrentUser() user: any) {
    return this.pollsService.vote(optionId, user.id);
  }
}
