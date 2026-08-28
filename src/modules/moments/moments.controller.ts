import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
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
import { MomentsService } from './moments.service';
import { CreateMomentDto } from './dto/create-moment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { ResourceOwnerGuard } from '../../common/guards/resource-owner.guard';
import { OwnedResource } from '../../common/decorators/resource-owner.decorator';
import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class CommentDto {
  @ApiProperty() @IsString() @IsNotEmpty() content: string;
}
class ReactionDto {
  @ApiProperty({ example: '🔥' }) @IsString() @IsNotEmpty() emoji: string;
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
  findAll(@Param('tripId') tripId: string) {
    return this.momentsService.findAll(tripId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiết khoảnh khắc + comments + reactions' })
  findOne(@Param('id') id: string) {
    return this.momentsService.findOne(id);
  }

  @UseGuards(ResourceOwnerGuard)
  @OwnedResource('moment', 'id')
  @Delete(':id')
  @ApiOperation({ summary: 'Xóa khoảnh khắc' })
  delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.momentsService.delete(id, user.id);
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Bình luận khoảnh khắc' })
  addComment(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: CommentDto,
  ) {
    return this.momentsService.addComment(id, user.id, dto.content);
  }

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
