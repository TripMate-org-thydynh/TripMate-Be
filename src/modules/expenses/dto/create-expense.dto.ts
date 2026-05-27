import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseCategory, SplitType } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SplitMemberDto {
  @ApiProperty()
  @IsUUID()
  userId: string;

  @ApiProperty({ example: 150000 })
  @IsNumber()
  @Min(0)
  amount: number;
}

export class CreateExpenseDto {
  @ApiProperty({ example: 450000 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ enum: ExpenseCategory, example: 'FOOD' })
  @IsEnum(ExpenseCategory)
  category: ExpenseCategory;

  @ApiPropertyOptional({ example: 'Lẩu gà lá é ăn tối ngày 1' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: SplitType, example: 'EQUAL' })
  @IsEnum(SplitType)
  splitType: SplitType;

  @ApiProperty({ description: 'User ID who paid' })
  @IsUUID()
  paidById: string;

  @ApiPropertyOptional({
    type: [SplitMemberDto],
    description: 'Required for EXACT/PERCENTAGE splits',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitMemberDto)
  splits?: SplitMemberDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiptUrl?: string;
}
