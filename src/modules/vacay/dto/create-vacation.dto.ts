import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVacationDayDto {
  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  date: string;

  @ApiProperty({ enum: ['LEAVE', 'HOLIDAY', 'WEEKEND'] })
  @IsIn(['LEAVE', 'HOLIDAY', 'WEEKEND'])
  type: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
