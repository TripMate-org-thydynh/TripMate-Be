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
import { BucketService } from './bucket.service';
import { CreateBucketItemDto } from './dto/create-bucket-item.dto';
import { UpdateBucketItemDto } from './dto/update-bucket-item.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Bucket List')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('users/me/bucket-list')
export class BucketController {
  constructor(private readonly bucketService: BucketService) {}

  @Get()
  @ApiOperation({ summary: 'Bucket list du lịch của tôi' })
  getList(@CurrentUser() user: User) {
    return this.bucketService.getList(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Thêm mục vào bucket list' })
  addItem(@CurrentUser() user: User, @Body() dto: CreateBucketItemDto) {
    return this.bucketService.addItem(user.id, dto);
  }

  @Patch(':itemId')
  @ApiOperation({ summary: 'Sửa / đánh dấu hoàn thành' })
  updateItem(
    @CurrentUser() user: User,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateBucketItemDto,
  ) {
    return this.bucketService.updateItem(user.id, itemId, dto);
  }

  @Delete(':itemId')
  @ApiOperation({ summary: 'Xoá mục bucket list' })
  deleteItem(@CurrentUser() user: User, @Param('itemId') itemId: string) {
    return this.bucketService.deleteItem(user.id, itemId);
  }
}
