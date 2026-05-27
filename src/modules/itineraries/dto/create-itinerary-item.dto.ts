import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateItineraryItemDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  day: number;

  @ApiProperty({ example: '08:00' })
  @IsString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({ example: 'Hồ Tuyền Lâm' })
  @IsString()
  @IsNotEmpty()
  placeName: string;

  @ApiPropertyOptional({ example: 'Phường 4, Đà Lạt' })
  @IsOptional()
  @IsString()
  placeAddress?: string;

  @ApiPropertyOptional({ example: 'ChIJ_google_place_id' })
  @IsOptional()
  @IsString()
  placeId?: string;

  @ApiPropertyOptional({ example: 11.940562 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 108.489723 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({ example: 120 })
  @IsInt()
  @Min(1)
  durationMinutes: number;

  @ApiPropertyOptional({ example: 'Chèo SUP ngắm sương mù buổi sáng' })
  @IsOptional()
  @IsString()
  notes?: string;
}
