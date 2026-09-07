import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ObservabilityService } from './observability.service';
import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsInt,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

// --- DTOS CHO QUERY VÀ CRUD ---

export class OverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Khoảng thời gian tính bằng phút (mặc định 60)',
    default: 60,
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'rangeMinutes phải là số nguyên' })
  @Min(1, { message: 'rangeMinutes tối thiểu là 1 phút' })
  rangeMinutes?: number = 60;
}

export class TimeseriesQueryDto {
  @ApiPropertyOptional({
    description: 'Khoảng thời gian tính bằng phút (mặc định 60)',
    default: 60,
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'rangeMinutes phải là số nguyên' })
  @Min(1, { message: 'rangeMinutes tối thiểu là 1 phút' })
  rangeMinutes?: number = 60;

  @ApiPropertyOptional({
    description: 'Kích thước bước gộp tính bằng phút (mặc định 1)',
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'stepMinutes phải là số nguyên' })
  @Min(1, { message: 'stepMinutes tối thiểu là 1 phút' })
  stepMinutes?: number = 1;
}

export class RoutesQueryDto {
  @ApiPropertyOptional({
    description: 'Khoảng thời gian tính bằng phút (mặc định 60)',
    default: 60,
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'rangeMinutes phải là số nguyên' })
  @Min(1, { message: 'rangeMinutes tối thiểu là 1 phút' })
  rangeMinutes?: number = 60;

  @ApiPropertyOptional({
    description: 'Số lượng route tối đa trả về (mặc định 20)',
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên' })
  @Min(1, { message: 'limit tối thiểu là 1' })
  @Max(100, { message: 'limit tối đa là 100' })
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Tiêu chí sắp xếp: requests, errors, hoặc latency',
    enum: ['requests', 'errors', 'latency'],
    default: 'requests',
    example: 'requests',
  })
  @IsOptional()
  @IsIn(['requests', 'errors', 'latency'], {
    message: 'sortBy phải là một trong: requests, errors, latency',
  })
  sortBy?: 'requests' | 'errors' | 'latency' = 'requests';
}

export class CreateSloTargetDto {
  @ApiProperty({
    description: 'Khoá định danh máy đọc (duy nhất, vd: api-availability)',
    example: 'api-availability',
  })
  @IsString()
  @IsNotEmpty({ message: 'key không được để trống' })
  key: string;

  @ApiProperty({
    description: 'Tên hiển thị mục tiêu SLO',
    example: 'API Availability 99.9%',
  })
  @IsString()
  @IsNotEmpty({ message: 'name không được để trống' })
  name: string;

  @ApiProperty({
    description: 'Loại chỉ số SLI: AVAILABILITY hoặc LATENCY',
    enum: ['AVAILABILITY', 'LATENCY'],
    example: 'AVAILABILITY',
  })
  @IsIn(['AVAILABILITY', 'LATENCY'], {
    message: 'sliType phải là AVAILABILITY hoặc LATENCY',
  })
  sliType: 'AVAILABILITY' | 'LATENCY';

  @ApiProperty({
    description: 'Mục tiêu phần trăm (0, 100]',
    example: 99.9,
  })
  @IsNumber({}, { message: 'objective phải là số thực' })
  @Min(0.001, { message: 'objective phải lớn hơn 0' })
  @Max(100, { message: 'objective không được vượt quá 100' })
  objective: number;

  @ApiPropertyOptional({
    description: 'Cửa sổ đánh giá tính theo ngày (mặc định 30)',
    default: 30,
    example: 30,
  })
  @IsOptional()
  @IsInt({ message: 'windowDays phải là số nguyên' })
  @Min(1, { message: 'windowDays phải lớn hơn hoặc bằng 1' })
  windowDays?: number = 30;

  @ApiPropertyOptional({
    description:
      'Ngưỡng mili-giây coi là nhanh (bắt buộc khi sliType=LATENCY)',
    example: 500,
  })
  @IsOptional()
  @IsInt({ message: 'latencyThresholdMs phải là số nguyên' })
  @Min(1, { message: 'latencyThresholdMs phải lớn hơn hoặc bằng 1' })
  latencyThresholdMs?: number;

  @ApiPropertyOptional({
    description: 'Tiền tố route lọc áp dụng (null hoặc bỏ trống = toàn hệ thống)',
    example: '/trips',
  })
  @IsOptional()
  @IsString()
  routePrefix?: string;

  @ApiPropertyOptional({
    description: 'Trạng thái kích hoạt (mặc định true)',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive phải là boolean' })
  isActive?: boolean = true;
}

export class UpdateSloTargetDto {
  @ApiPropertyOptional({
    description: 'Khoá định danh máy đọc (duy nhất)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'key không được để trống' })
  key?: string;

  @ApiPropertyOptional({
    description: 'Tên hiển thị mục tiêu SLO',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'name không được để trống' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Loại chỉ số SLI: AVAILABILITY hoặc LATENCY',
    enum: ['AVAILABILITY', 'LATENCY'],
  })
  @IsOptional()
  @IsIn(['AVAILABILITY', 'LATENCY'], {
    message: 'sliType phải là AVAILABILITY hoặc LATENCY',
  })
  sliType?: 'AVAILABILITY' | 'LATENCY';

  @ApiPropertyOptional({
    description: 'Mục tiêu phần trăm (0, 100]',
  })
  @IsOptional()
  @IsNumber({}, { message: 'objective phải là số thực' })
  @Min(0.001, { message: 'objective phải lớn hơn 0' })
  @Max(100, { message: 'objective không được vượt quá 100' })
  objective?: number;

  @ApiPropertyOptional({
    description: 'Cửa sổ đánh giá tính theo ngày',
  })
  @IsOptional()
  @IsInt({ message: 'windowDays phải là số nguyên' })
  @Min(1, { message: 'windowDays phải lớn hơn hoặc bằng 1' })
  windowDays?: number;

  @ApiPropertyOptional({
    description: 'Ngưỡng mili-giây coi là nhanh',
  })
  @IsOptional()
  @IsInt({ message: 'latencyThresholdMs phải là số nguyên' })
  @Min(1, { message: 'latencyThresholdMs phải lớn hơn hoặc bằng 1' })
  latencyThresholdMs?: number;

  @ApiPropertyOptional({
    description: 'Tiền tố route lọc áp dụng (để trống để bỏ lọc)',
  })
  @IsOptional()
  @IsString()
  routePrefix?: string;

  @ApiPropertyOptional({
    description: 'Trạng thái kích hoạt',
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive phải là boolean' })
  isActive?: boolean;
}

@ApiTags('Admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth('JWT')
@Controller('admin/observability')
export class ObservabilityController {
  constructor(
    private readonly observabilityService: ObservabilityService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Lấy thẻ tổng quan hiệu năng hệ thống (admin)' })
  getOverview(@Query() query: OverviewQueryDto) {
    return this.observabilityService.getOverview(query.rangeMinutes);
  }

  @Get('timeseries')
  @ApiOperation({
    summary: 'Lấy chuỗi thời gian biểu đồ hiệu năng hệ thống (admin)',
  })
  getTimeseries(@Query() query: TimeseriesQueryDto) {
    return this.observabilityService.getTimeseries(
      query.rangeMinutes,
      query.stepMinutes,
    );
  }

  @Get('routes')
  @ApiOperation({
    summary: 'Lấy thống kê hiệu năng chi tiết theo từng route (admin)',
  })
  getRoutes(@Query() query: RoutesQueryDto) {
    return this.observabilityService.getRoutes(
      query.rangeMinutes,
      query.limit,
      query.sortBy,
    );
  }

  @Get('slo/targets')
  @ApiOperation({
    summary: 'Lấy danh sách tất cả mục tiêu SLO đã cấu hình (admin)',
  })
  getSloTargets() {
    return this.observabilityService.getSloTargets();
  }

  @Post('slo/targets')
  @ApiOperation({ summary: 'Tạo mới mục tiêu SLO (admin)' })
  createSloTarget(@Body() dto: CreateSloTargetDto) {
    return this.observabilityService.createSloTarget(dto);
  }

  @Patch('slo/targets/:id')
  @ApiOperation({ summary: 'Cập nhật mục tiêu SLO (admin)' })
  updateSloTarget(
    @Param('id') id: string,
    @Body() dto: UpdateSloTargetDto,
  ) {
    return this.observabilityService.updateSloTarget(id, dto);
  }

  @Delete('slo/targets/:id')
  @ApiOperation({ summary: 'Xoá mục tiêu SLO (admin)' })
  deleteSloTarget(@Param('id') id: string) {
    return this.observabilityService.deleteSloTarget(id);
  }

  @Get('slo')
  @ApiOperation({
    summary: 'Đánh giá SLO và ngân sách lỗi Error Budget (admin)',
  })
  getSloOverview() {
    return this.observabilityService.getSloOverview();
  }
}
