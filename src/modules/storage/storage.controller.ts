import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import { StorageService } from './storage.service';

@ApiTags('Storage')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('upload-ticket')
  @ApiOperation({
    summary: 'Xin vé tải file lên Cloudinary (app upload thẳng, không qua BE)',
  })
  createTicket(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body('contentType') contentType: string,
    @Body('sizeBytes') sizeBytes?: number,
  ) {
    return this.storage.createUploadTicket(
      tripId,
      user.id,
      contentType,
      sizeBytes,
    );
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Báo đã tải xong để ghi vào bảng media' })
  confirm(
    @CurrentUser() user: User,
    @Body('url') url: string,
    @Body('contentType') contentType: string,
    @Body('sizeBytes') sizeBytes?: number,
  ) {
    return this.storage.recordMedia(user.id, url, contentType, sizeBytes);
  }
}
