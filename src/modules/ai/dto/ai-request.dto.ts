import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AIRequestType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Một lượt đã nói trong hội thoại, để AI hiểu câu hỏi nối tiếp. */
export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  content: string;
}

export class CreateAIRequestDto {
  @ApiProperty({ enum: AIRequestType })
  @IsEnum(AIRequestType)
  type: AIRequestType;

  @ApiProperty({
    example: 'Lên kế hoạch 3 ngày ở Đà Lạt cho nhóm 4 người thích chill',
  })
  @IsString()
  @IsNotEmpty()
  // Chặn prompt khổng lồ: vừa tốn tiền token vừa là cách rẻ nhất để phá server.
  @MaxLength(4000)
  prompt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('loose')
  tripId?: string;

  @ApiPropertyOptional({
    type: [ChatTurnDto],
    description:
      'Vài lượt gần nhất của hội thoại. Có thì câu hỏi nối tiếp kiểu ' +
      '"chỗ đó vé bao nhiêu?" mới hiểu được.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];
}
