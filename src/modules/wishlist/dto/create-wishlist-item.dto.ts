import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum WishlistItemTypeDto {
  FOOD = 'FOOD',
  PLACE = 'PLACE',
}

export class CreateWishlistItemDto {
  @IsEnum(WishlistItemTypeDto)
  type: WishlistItemTypeDto;

  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  link?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
