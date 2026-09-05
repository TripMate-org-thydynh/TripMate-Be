import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReservationsService } from './reservations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/** Feed liên chuyến cho dashboard — vé/booking sắp tới của user (giống TREK). */
@ApiTags('Reservations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('users/me/reservations')
export class UpcomingReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get('upcoming')
  @ApiOperation({ summary: 'Vé/booking sắp tới trên mọi chuyến' })
  upcoming(@CurrentUser() user: User) {
    return this.reservationsService.listUpcoming(user.id);
  }
}
