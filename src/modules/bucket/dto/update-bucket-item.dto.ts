import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBucketItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;
}
