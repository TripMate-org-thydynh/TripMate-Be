import { IsInt, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDocumentDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  url: string;

  @ApiProperty()
  @IsString()
  mimeType: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiPropertyOptional({ description: 'TRIP | RESERVATION | PLACE' })
  @IsOptional()
  @IsString()
  linkedType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  linkedId?: string;
}
