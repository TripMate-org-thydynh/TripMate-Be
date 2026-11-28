import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional,
  IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

const MAX_VND = 9_999_999_999;

export class ReceiptLineDto {
  @IsString() @Matches(/\S/) @MaxLength(120)
  name!: string;

  @IsInt() @Min(1) @Max(MAX_VND)
  amount!: number;
}

export class ReceiptDetailsDto {
  @IsString() @Matches(/\S/) @MaxLength(120)
  title!: string;

  @IsInt() @Min(1) @Max(MAX_VND)
  total!: number;

  @IsOptional() @IsInt() @Min(0) @Max(MAX_VND)
  tax?: number;

  @IsOptional() @IsInt() @Min(0) @Max(MAX_VND)
  fee?: number;

  @IsOptional() @IsInt() @Min(0) @Max(MAX_VND)
  discount?: number;
}

export class CreateReceiptDraftDto extends ReceiptDetailsDto {
  @IsUUID('4')
  id!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => ReceiptLineDto)
  lines!: ReceiptLineDto[];
}

export class ReceiptRevisionDto {
  @Type(() => Number)
  @IsInt() @Min(0) @Max(2_147_483_646)
  version!: number;
}

export class UpdateReceiptDetailsDto extends ReceiptDetailsDto {
  @IsInt() @Min(0) @Max(2_147_483_646)
  version!: number;
}

export class EditReceiptLineDto extends ReceiptLineDto {
  @IsInt() @Min(0) @Max(2_147_483_646)
  version!: number;
}

export class AssignReceiptLineDto extends ReceiptRevisionDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(30) @IsUUID('all', { each: true })
  assigneeIds!: string[];
}
