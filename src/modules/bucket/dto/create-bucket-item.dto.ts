import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateBucketItemDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(160)
  title: string;
}
