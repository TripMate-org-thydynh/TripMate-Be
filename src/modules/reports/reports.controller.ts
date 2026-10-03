import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ReportReason, ReportStatus, ReportTarget } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';

export class CreateReportDto {
  @IsEnum(ReportTarget)
  targetType: ReportTarget;

  @IsUUID()
  targetId: string;

  @IsEnum(ReportReason)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveReportDto {
  @IsIn(['RESOLVED', 'DISMISSED'])
  decision: 'RESOLVED' | 'DISMISSED';

  @IsOptional()
  @IsBoolean()
  hide?: boolean;
}

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  // Giới hạn chặt hơn mặc định: báo cáo hàng loạt là cách dập nội dung người khác.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Báo cáo nội dung hoặc người dùng vi phạm' })
  create(@CurrentUser() user: User, @Body() dto: CreateReportDto) {
    return this.reports.create(
      user.id,
      dto.targetType,
      dto.targetId,
      dto.reason,
      dto.note?.trim() || undefined,
    );
  }
}

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private reports: ReportsService) {}

  @Get()
  @ApiOperation({ summary: 'Hàng chờ báo cáo vi phạm' })
  list(@Query('status') status?: string) {
    const s = (Object.values(ReportStatus) as string[]).includes(status ?? '')
      ? (status as ReportStatus)
      : 'OPEN';
    return this.reports.list(s);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Chốt báo cáo (gỡ nội dung hoặc bác)' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.reports.resolve(id, dto.decision, dto.hide ?? false);
  }
}
