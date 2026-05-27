import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { PresenceStatus } from '@prisma/client';

export class UpdatePresenceDto {
  @ApiPropertyOptional({ enum: PresenceStatus, example: 'ONLINE' })
  @IsOptional()
  @IsEnum(PresenceStatus)
  status?: PresenceStatus;

  @ApiPropertyOptional({ example: 'f391263a-bb10-4f81-a957-3f3984d6b9e2' })
  @IsOptional()
  @IsString()
  currentTripId?: string;

  @ApiPropertyOptional({ example: 11.94006 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 108.43731 })
  @IsOptional()
  @IsNumber()
  longitude?: number;
}
