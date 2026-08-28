import type { RequestWithUser } from '../../common/types/request-with-user';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { ImportReservationDto } from './dto/import-reservation.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';

@Controller('trips/:tripId/reservations')
@UseGuards(JwtAuthGuard, TripMemberGuard)
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  list(@Param('tripId') tripId: string) {
    return this.reservationsService.list(tripId);
  }

  @Post()
  create(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(tripId, req.user.id, dto);
  }

  /**
   * Import vé từ text (dán email/xác nhận).
   * Tự động tạo expense nếu vé có giá.
   * Response: { created, items, expensesCreated }
   */
  @Post('import')
  importFromText(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: ImportReservationDto,
  ) {
    return this.reservationsService.importFromText(
      tripId,
      req.user.id,
      dto.text ?? '',
    );
  }

  /**
   * Import vé từ ảnh / PDF (Gemini vision).
   * Tự động tạo expense nếu vé có giá.
   * Response: { created, items, expensesCreated }
   */
  @Post('import-image')
  importFromImage(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: ImportReservationDto,
  ) {
    return this.reservationsService.importFromImage(
      tripId,
      req.user.id,
      dto.imageBase64 ?? '',
      dto.mimeType ?? 'image/jpeg',
    );
  }

  @Patch(':itemId')
  update(
    @Param('itemId') itemId: string,
    @Request() req: RequestWithUser,
    @Body() dto: UpdateReservationDto,
  ) {
    return this.reservationsService.update(itemId, req.user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('reservation', 'itemId')
  @Delete(':itemId')
  remove(@Param('itemId') itemId: string, @Request() req: RequestWithUser) {
    return this.reservationsService.remove(itemId, req.user.id);
  }
}
