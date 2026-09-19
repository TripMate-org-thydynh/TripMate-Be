import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PublishTemplateDto {
  @ApiPropertyOptional({ example: 'Đà Lạt 4 ngày chill cho nhóm bạn' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /// Ghi chú riêng của nhóm (số phòng, SĐT...) có thể nhạy cảm — mặc định KHÔNG chép.
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  includeNotes?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class ListTemplatesQuery {
  @ApiPropertyOptional({ description: 'Tìm theo tiêu đề / điểm đến' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ description: 'Số ngày chính xác' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  days?: number;

  @ApiPropertyOptional({ enum: ['popular', 'new'], default: 'popular' })
  @IsOptional()
  @IsIn(['popular', 'new'])
  sort?: 'popular' | 'new';

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class DuplicateTemplateDto {
  /// Chép vào chuyến đang có (phải là thành viên). Bỏ trống → tạo chuyến mới.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tripId?: string;

  /// Tên chuyến mới. Mặc định lấy tiêu đề mẫu.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  /// Ngày bắt đầu chuyến mới (YYYY-MM-DD). Mặc định: 7 ngày tới.
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;
}
