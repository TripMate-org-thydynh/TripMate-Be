import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CampaignDraftDto {
  @IsString() @Matches(/\S/) @MaxLength(90)
  title!: string;
  @IsString() @Matches(/\S/) @MaxLength(320)
  body!: string;
  @IsOptional() @IsString() @MaxLength(500)
  imageUrl?: string;
  @IsIn(['home', 'trips', 'templates'])
  cta!: string;
  @IsIn(['all', 'ios', 'android'])
  platform!: string;
  @IsISO8601() @Matches(/(Z|[+-]\d\d:\d\d)$/)
  startsAt!: string;
  @IsISO8601() @Matches(/(Z|[+-]\d\d:\d\d)$/)
  endsAt!: string;
  @IsBoolean()
  popup!: boolean;
  @IsBoolean()
  push!: boolean;
}

export class CampaignPublishDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(250) @ArrayUnique() @IsUUID('all', { each: true })
  userIds!: string[];
  @IsString() @Matches(/\S/) @MaxLength(240)
  reason!: string;
}
