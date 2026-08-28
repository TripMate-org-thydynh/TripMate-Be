import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class JournalPhotoDto {
  @ApiProperty()
  @IsString()
  mediaUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  caption?: string;
}

export class CreateJournalEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(10000)
  body: string;

  @ApiProperty({ enum: ['HAPPY', 'CHILL', 'TIRED', 'WOW', 'SAD', 'EXCITED', 'ANNOYED'] })
  @IsIn(['HAPPY', 'CHILL', 'TIRED', 'WOW', 'SAD', 'EXCITED', 'ANNOYED'])
  mood: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD' })
  @IsDateString()
  entryDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({ type: [JournalPhotoDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalPhotoDto)
  photos?: JournalPhotoDto[];
}

export class UpdateJournalEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['HAPPY', 'CHILL', 'TIRED', 'WOW', 'SAD', 'EXCITED', 'ANNOYED'])
  mood?: string;
}
