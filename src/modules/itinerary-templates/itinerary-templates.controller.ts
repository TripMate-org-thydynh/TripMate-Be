import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TripMemberGuard } from '../../common/guards/trip-member.guard';
import {
  DuplicateTemplateDto,
  ListTemplatesQuery,
  PublishTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { ItineraryTemplatesService } from './itinerary-templates.service';

@ApiTags('Itinerary Templates')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT')
@Controller('itinerary-templates')
export class ItineraryTemplatesController {
  constructor(private readonly service: ItineraryTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Khám phá lịch trình mẫu công khai' })
  list(@Query() q: ListTemplatesQuery) {
    return this.service.listPublic(q);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Lịch trình mẫu tôi đã đăng' })
  mine(@CurrentUser() user: User) {
    return this.service.listMine(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết lịch trình mẫu kèm điểm dừng' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.service.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa tiêu đề / mô tả / công khai (tác giả)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.service.update(id, user.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Gỡ lịch trình mẫu (tác giả)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.service.remove(id, user.id);
  }

  @Post(':id/duplicate')
  @ApiOperation({
    summary: 'Nhân bản mẫu thành chuyến mới, hoặc chép vào chuyến đang có',
  })
  duplicate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: DuplicateTemplateDto,
  ) {
    return this.service.duplicate(id, user.id, dto);
  }
}

/** Đăng lịch trình của một chuyến thành mẫu — nằm dưới /trips để dùng TripMemberGuard. */
@ApiTags('Itinerary Templates')
@UseGuards(JwtAuthGuard, TripMemberGuard)
@ApiBearerAuth('JWT')
@Controller('trips/:tripId/itinerary/templates')
export class TripTemplatePublishController {
  constructor(private readonly service: ItineraryTemplatesService) {}

  @Post()
  @ApiOperation({ summary: 'Đăng lịch trình chuyến này thành mẫu' })
  publish(
    @Param('tripId') tripId: string,
    @CurrentUser() user: User,
    @Body() dto: PublishTemplateDto,
  ) {
    return this.service.publish(tripId, user.id, dto);
  }
}
