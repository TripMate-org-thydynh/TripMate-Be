import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDocumentDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiProperty()
  // Chỉ https: chặn `javascript:` / `data:` được lưu rồi mở ở máy người khác.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  mimeType: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiPropertyOptional({ description: 'TRIP | RESERVATION | PLACE' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  linkedType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  linkedId?: string;
}
