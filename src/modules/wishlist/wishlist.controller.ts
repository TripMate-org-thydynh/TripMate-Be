import type { RequestWithUser } from '../../common/types/request-with-user';
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { WishlistService } from './wishlist.service';
import { CreateWishlistItemDto } from './dto/create-wishlist-item.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';

@Controller('trips/:tripId/wishlist')
@UseGuards(JwtAuthGuard, TripMemberGuard)
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  getWishlist(
    @Param('tripId') tripId: string,
    @Query('type') type?: 'FOOD' | 'PLACE',
  ) {
    return this.wishlistService.getWishlist(tripId, type);
  }

  @Post()
  addItem(
    @Param('tripId') tripId: string,
    @Request() req: RequestWithUser,
    @Body() dto: CreateWishlistItemDto,
  ) {
    return this.wishlistService.addItem(tripId, req.user.id, dto);
  }

  @Post(':itemId/vote')
  toggleVote(@Param('itemId') itemId: string, @Request() req: RequestWithUser) {
    return this.wishlistService.toggleVote(itemId, req.user.id);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('wishlistItem', 'itemId')
  @Delete(':itemId')
  deleteItem(@Param('itemId') itemId: string, @Request() req: RequestWithUser) {
    return this.wishlistService.deleteItem(itemId, req.user.id);
  }
}
