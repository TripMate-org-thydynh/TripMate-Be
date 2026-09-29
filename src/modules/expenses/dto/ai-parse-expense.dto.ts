import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_TEXT } from '../ai-expense-parse';

export class ParseAnswerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  question: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  answer: string;
}

export class AiParseExpenseDto {
  @ApiProperty({ description: 'Mô tả chi tiêu bằng lời' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEXT)
  text: string;

  @ApiPropertyOptional({ type: [ParseAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ParseAnswerDto)
  answers?: ParseAnswerDto[];
}
