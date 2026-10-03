import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MomentType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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
}
