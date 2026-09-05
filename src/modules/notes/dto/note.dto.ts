import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(5000)
  content: string;

  @ApiPropertyOptional({ description: 'Hex color e.g. #FFD84D' })
  @IsOptional()
  @IsString()
  color?: string;
}

export class UpdateNoteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  color?: string;
}
