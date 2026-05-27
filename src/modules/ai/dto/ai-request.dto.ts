import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AIRequestType } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateAIRequestDto {
  @ApiProperty({ enum: AIRequestType })
  @IsEnum(AIRequestType)
  type: AIRequestType;

  @ApiProperty({
    example: 'Lên kế hoạch 3 ngày ở Đà Lạt cho nhóm 4 người thích chill',
  })
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tripId?: string;
}
