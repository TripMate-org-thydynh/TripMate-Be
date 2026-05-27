import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CategoryLimitDto {
  @ApiProperty({ example: 'FOOD' })
  @IsString()
  category: string;

  @ApiProperty({ example: 4000000.0 })
  @IsNumber()
  @Min(0)
  amount: number;
}

export class UpdateBudgetGoalDto {
  @ApiPropertyOptional({ example: 15000000.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  limitAmount?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  warningPercentage?: number;

  @ApiPropertyOptional({ type: [CategoryLimitDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CategoryLimitDto)
  categoryLimits?: CategoryLimitDto[];
}
