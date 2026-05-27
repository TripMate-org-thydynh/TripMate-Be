import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MomentType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateMomentDto {
  @ApiProperty({ example: 'https://storage.supabase.co/...' })
  @IsString()
  @IsNotEmpty()
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
  caption?: string;

  @ApiPropertyOptional({ example: 11.940562 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 108.489723 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mediaId?: string;
}
