import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MomentsService } from './moments.service';
import { CreateMomentDto } from './dto/create-moment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { InTrip } from '../../common/guards/trip-resource.guard';

class CommentDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(1000) content: string;
}
class ReactionDto {
  @ApiProperty({ example: '🔥' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  emoji: string;
}

@ApiTags('Moments')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/moments')
export class MomentsController {
  constructor(private readonly momentsService: MomentsService) {}

  @Post()
  @ApiOperation({ summary: 'Chia sẻ khoảnh khắc mới' })
  create(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateMomentDto,
  ) {
    return this.momentsService.create(tripId, user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Bảng tin kỷ niệm của chuyến đi' })
  findAll(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.momentsService.findAll(tripId, user.id);
  }

  // Khai báo trước ':id' để không bị route động nuốt mất.
  @Get('developing')
  @ApiOperation({ summary: 'Ghost Cam: số ảnh đang chờ tráng và mốc tráng' })
  developing(@Param('tripId') tripId: string, @CurrentUser() user: User) {
    return this.momentsService.developing(tripId, user.id);
  }

  @InTrip('moment', 'id')
  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiết khoảnh khắc + comments + reactions' })
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.momentsService.findOne(id, user.id);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('moment', 'id')
  @InTrip('moment', 'id')
  @Patch(':id')
  @ApiOperation({ summary: 'Sửa caption khoảnh khắc (chỉ tác giả)' })
  updateCaption(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body('caption') caption: string,
  ) {
    // `@Body('caption')` không qua DTO nên tự chặn kiểu và độ dài.
    const safeCaption = typeof caption === 'string' ? caption.slice(0, 2000) : '';
    return this.momentsService.updateCaption(id, user.id, safeCaption);
  }

  @InTrip('moment', 'id')
  @Delete(':id')
  @ApiOperation({ summary: 'Xóa khoảnh khắc' })
  delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.momentsService.delete(id, user.id);
  }

  @InTrip('moment', 'id')
  @Post(':id/comments')
  @ApiOperation({ summary: 'Bình luận khoảnh khắc' })
  addComment(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: CommentDto,
  ) {
    return this.momentsService.addComment(id, user.id, dto.content);
  }

  @InTrip('moment', 'id')
  @Post(':id/reactions')
  @ApiOperation({ summary: 'Thả cảm xúc (toggle)' })
  toggleReaction(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: ReactionDto,
  ) {
    return this.momentsService.toggleReaction(id, user.id, dto.emoji);
  }
}
