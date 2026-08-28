import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class UpdatePackingItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsBoolean()
  isPacked?: boolean;

  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  /** Client sends the last-known updatedAt for optimistic concurrency. Optional for backward compat. */
  @IsOptional()
  @IsISO8601()
  updatedAt?: string;
}
