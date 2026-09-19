import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsArray,
  IsIn,
  ArrayMaxSize,
  ArrayMinSize,
  Matches,
  ValidateNested,
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

export class CustomizeTemplateDto {
  @ApiPropertyOptional({ example: 'Nhóm 6 người, thích ăn uống, ít leo núi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  request: string;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  groupSize?: number;

  @ApiPropertyOptional({
    example: 3000000,
    description: 'Tổng ngân sách cả nhóm (VND)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  budget?: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(14)
  days?: number;
}

/** Một điểm dừng trong bản đã chỉnh (do AI đề xuất, người dùng đã xem). */
export class CustomItemDto {
  @IsInt()
  @Min(1)
  @Max(30)
  day: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  placeName: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  placeAddress?: string;

  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  category?: string;
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

  /// Bản đã chỉnh bằng AI (xem trước ở /customize). Có thì dùng thay cho điểm của mẫu.
  @ApiPropertyOptional({ type: [CustomItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => CustomItemDto)
  items?: CustomItemDto[];
}
