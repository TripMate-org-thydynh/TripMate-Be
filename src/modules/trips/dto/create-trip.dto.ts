import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateTripDto {
  @ApiProperty({ example: 'Phượt Đà Lạt Chill Chill ☁️' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Chuyến đi chill đầu hè nhóm 4 người' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'Đà Lạt, Lâm Đồng' })
  @IsOptional()
  @IsString()
  destination?: string;

  @ApiPropertyOptional({ example: 5000000, description: 'Ngân sách dự kiến' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;

  @ApiPropertyOptional({ example: 'CHILL', description: 'Vibe chuyến đi' })
  @IsOptional()
  @IsString()
  vibe?: string;

  @ApiProperty({ example: '2026-06-15' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-06-18' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImage?: string;

  @ApiPropertyOptional({ example: 'VND', default: 'VND' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: 'forest' })
  @IsOptional()
  @IsString()
  theme?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
