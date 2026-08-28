import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export enum ReservationTypeDto {
  FLIGHT = 'FLIGHT',
  TRAIN = 'TRAIN',
  BUS = 'BUS',
  HOTEL = 'HOTEL',
  RESTAURANT = 'RESTAURANT',
  CAR = 'CAR',
  EVENT = 'EVENT',
  ATTRACTION = 'ATTRACTION',
  OTHER = 'OTHER',
}

export class CreateReservationDto {
  @IsEnum(ReservationTypeDto)
  type: ReservationTypeDto;

  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  confirmationNumber?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsISO8601()
  startTime?: string;

  @IsOptional()
  @IsISO8601()
  endTime?: string;
}
