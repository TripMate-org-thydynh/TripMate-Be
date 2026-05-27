import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreatePollDto {
  @ApiProperty({ example: 'Tối nay ăn gì nhỉ? 🍜' })
  @IsString()
  @IsNotEmpty()
  question: string;

  @ApiProperty({ example: ['Lẩu gà lá é', 'Bún bò', 'Bánh mì pate'] })
  @IsArray()
  @IsString({ each: true })
  @MinLength(2, { each: true })
  options: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isMultiple?: boolean;

  @ApiPropertyOptional({ example: '2026-06-15T20:00:00Z' })
  @IsOptional()
  @IsDateString()
  closesAt?: string;
}
