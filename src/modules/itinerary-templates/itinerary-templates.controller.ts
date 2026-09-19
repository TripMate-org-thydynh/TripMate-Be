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
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  FeatureTemplateDto,
  RateTemplateDto,
  CustomizeTemplateDto,
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

  @Get('featured')
  @ApiOperation({ summary: 'Mẫu nổi bật (admin ghim + điểm cao)' })
  featured() {
    return this.service.featured();
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

  @Get(':id/me')
  @ApiOperation({ summary: 'Tôi đã dùng mẫu này chưa, đã chấm mấy sao' })
  me(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.service.myState(id, user.id);
  }

  @Get(':id/ratings')
  @ApiOperation({ summary: 'Nhận xét gần đây của mẫu' })
  ratings(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.recentRatings(id);
  }

  @Post(':id/rating')
  @ApiOperation({
    summary: 'Chấm sao mẫu (phải đã dùng mẫu, không phải tác giả)',
  })
  rate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: RateTemplateDto,
  ) {
    return this.service.rate(id, user.id, dto);
  }

  @Patch(':id/featured')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Admin ghim/bỏ ghim mẫu nổi bật' })
  setFeatured(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeatureTemplateDto,
  ) {
    return this.service.setFeatured(id, dto.isFeatured);
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

  @Post(':id/customize')
  @ApiOperation({
    summary: 'AI chỉnh mẫu theo nhóm (xem trước, không ghi) — tính hạn mức AI',
  })
  customize(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: CustomizeTemplateDto,
  ) {
    return this.service.customize(id, user.id, dto);
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
