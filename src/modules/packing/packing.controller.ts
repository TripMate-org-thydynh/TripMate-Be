import type { RequestWithUser } from '../../common/types/request-with-user';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { PackingService } from './packing.service';
import { CreatePackingItemDto } from './dto/create-packing-item.dto';
import { UpdatePackingItemDto } from './dto/update-packing-item.dto';
import { ApplyTemplateDto } from './dto/apply-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';

@Controller('trips/:tripId/packing')
@UseGuards(JwtAuthGuard, TripMemberGuard)
export class PackingController {
  constructor(private readonly packingService: PackingService) {}

  @Get()
  getList(
    @Param('tripId') tripId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (page || limit) {
      return this.packingService.getListPaginated(
        tripId,
        page ? parseInt(page, 10) : 1,
        limit ? parseInt(limit, 10) : 50,
      );
    }
    return this.packingService.getList(tripId);
  }

  @Post()
  addItem(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: CreatePackingItemDto,
  ) {
    return this.packingService.addItem(tripId, req.user.id, dto);
  }

  @Post('template')
  applyTemplate(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: ApplyTemplateDto,
  ) {
    return this.packingService.applyTemplate(tripId, req.user.id, dto.template);
  }

  @Patch(':itemId')
  updateItem(
    @Param('itemId') itemId: string,
    @Request() req: RequestWithUser,
    @Body() dto: UpdatePackingItemDto,
  ) {
    return this.packingService.updateItem(itemId, req.user.id, dto);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('packingItem', 'itemId')
  @Delete(':itemId')
  deleteItem(@Param('itemId') itemId: string) {
    return this.packingService.deleteItem(itemId);
  }
}
