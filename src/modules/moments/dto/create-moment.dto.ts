import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MomentType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const ALLOWED_BOARD_FILTERS = [
  'CLASSIC',
  'WARM_VINTAGE',
  'FILM_GRAIN',
  'COOL_FADE',
  'HIGH_CONTRAST',
] as const;

export class CreateMomentDto {
  @ApiProperty({ example: 'https://storage.supabase.co/...' })
  // Chỉ https: chặn `javascript:` / `data:` được lưu rồi mở ở máy người khác.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  mediaUrl: string;

  @ApiPropertyOptional({ enum: MomentType, default: 'PHOTO' })
  @IsOptional()
  @IsEnum(MomentType)
  type?: MomentType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isGhost?: boolean;

  @ApiPropertyOptional({ example: 'Bình minh chill nhất 2026 🌅' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  caption?: string;

  @ApiPropertyOptional({ example: 11.940562 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 108.489723 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mediaId?: string;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsNumber()
  @Min(-10000)
  @Max(10000)
  boardX?: number;

  @ApiPropertyOptional({ example: 240 })
  @IsOptional()
  @IsNumber()
  @Min(-10000)
  @Max(10000)
  boardY?: number;

  @ApiPropertyOptional({ example: -3.5 })
  @IsOptional()
  @IsNumber()
  @Min(-45)
  @Max(45)
  boardRotation?: number;

  @ApiPropertyOptional({ example: 1.0 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(2.5)
  boardScale?: number;

  @ApiPropertyOptional({ enum: ALLOWED_BOARD_FILTERS, default: 'CLASSIC' })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_BOARD_FILTERS)
  boardFilter?: string;

  @ApiPropertyOptional({ example: '#FFF8E7' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  noteColor?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  takenAt?: string;
}

export class UpdateMomentLayoutDto {
  @ApiPropertyOptional({ example: 160 })
  @IsOptional()
  @IsNumber()
  @Min(-10000)
  @Max(10000)
  boardX?: number;

  @ApiPropertyOptional({ example: 320 })
  @IsOptional()
  @IsNumber()
  @Min(-10000)
  @Max(10000)
  boardY?: number;

  @ApiPropertyOptional({ example: 4.2 })
  @IsOptional()
  @IsNumber()
  @Min(-45)
  @Max(45)
  boardRotation?: number;

  @ApiPropertyOptional({ example: 1.15 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(2.5)
  boardScale?: number;

  @ApiPropertyOptional({ enum: ALLOWED_BOARD_FILTERS })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_BOARD_FILTERS)
  boardFilter?: string;

  @ApiPropertyOptional({ example: '#FFF8E7' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  noteColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional({ example: 'Bình minh chill nhất 2026 🌅' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  caption?: string;
}
