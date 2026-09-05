import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl } from 'class-validator';

export class UpdateSocialsDto {
  @ApiPropertyOptional({ example: 'https://facebook.com/minhnhatchaos' })
  @IsOptional()
  @IsUrl()
  facebook?: string;

  @ApiPropertyOptional({ example: 'https://instagram.com/minhnhat.travel' })
  @IsOptional()
  @IsUrl()
  instagram?: string;

  @ApiPropertyOptional({ example: 'https://tiktok.com/@minhnhat.phuot' })
  @IsOptional()
  @IsUrl()
  tiktok?: string;
}
