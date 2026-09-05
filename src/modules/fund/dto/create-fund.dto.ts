import {
  IsNumber,
  IsOptional,
  IsString,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateFundDto {
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  targetAmount: number;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
