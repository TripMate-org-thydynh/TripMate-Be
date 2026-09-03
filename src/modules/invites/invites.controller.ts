import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InvitesService } from './invites.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Invites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('trips')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post(':tripId/invites')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Tạo invite link có hạn / dùng 1 lần' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitesService.createInvite(tripId, user.id, dto);
  }

  @Get(':tripId/invites')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Danh sách invite links' })
  getAll(@Param('tripId') tripId: string) {
    return this.invitesService.getInvites(tripId);
  }

  @Delete(':tripId/invites/:inviteId')
  @UseGuards(TripMemberGuard)
  @ApiOperation({ summary: 'Vô hiệu hóa invite link' })
  deactivate(@Param('inviteId') inviteId: string, @CurrentUser() user: User) {
    return this.invitesService.deactivateInvite(inviteId, user.id);
  }

  @Post('join-link/:code')
  @ApiOperation({ summary: 'Tham gia trip bằng invite link code' })
  joinByCode(@Param('code') code: string, @CurrentUser() user: User) {
    return this.invitesService.joinByCode(code, user.id);
  }
}
