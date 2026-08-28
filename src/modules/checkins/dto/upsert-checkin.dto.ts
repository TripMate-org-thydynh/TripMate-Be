import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertCheckinDto {
  @ApiProperty({ description: 'Day number (1-based)' })
  @IsInt()
  @Min(1)
  day: number;

  @ApiProperty({ enum: ['GOING', 'MAYBE', 'OUT'] })
  @IsIn(['GOING', 'MAYBE', 'OUT'])
  status: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
