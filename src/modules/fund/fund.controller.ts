import type { RequestWithUser } from '../../common/types/request-with-user';
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { FundService } from './fund.service';
import { CreateFundDto } from './dto/create-fund.dto';
import { AddContributionDto } from './dto/add-contribution.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';

@Controller('trips/:tripId/fund')
@UseGuards(JwtAuthGuard, TripMemberGuard)
export class FundController {
  constructor(private readonly fundService: FundService) {}

  @Post()
  createFund(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: CreateFundDto,
  ) {
    return this.fundService.createFund(tripId, req.user.id, dto);
  }

  @Get()
  getFund(@Param('tripId') tripId: string) {
    return this.fundService.getFund(tripId);
  }

  @Post('contribute')
  addContribution(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: AddContributionDto,
  ) {
    return this.fundService.addContribution(tripId, req.user.id, dto);
  }

  @Delete('contributions/:id')
  deleteContribution(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.fundService.deleteContribution(id, req.user.id);
  }
}
