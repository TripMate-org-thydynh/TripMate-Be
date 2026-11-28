import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ItineraryTemplatesService } from './itinerary-templates.service';

@Controller('public/trip-templates')
export class TemplateCatalogController {
  constructor(private readonly templates: ItineraryTemplatesService) {}

  @Get()
  catalog() {
    return this.templates.editorial();
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.editorial(id);
  }
}

class ReviewTemplateDto {
  @IsBoolean()
  approve!: boolean;
  @IsString() @Matches(/\S/) @MaxLength(240)
  reason!: string;
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/template-review')
export class TemplateReviewController {
  constructor(private readonly templates: ItineraryTemplatesService) {}

  @Get()
  list() {
    return this.templates.reviewQueue();
  }

  @Post(':id')
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewTemplateDto, @CurrentUser() user: User) {
    return this.templates.review(id, dto.approve, dto.reason.trim(), user.id);
  }
}
