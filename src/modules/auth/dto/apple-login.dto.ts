import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AppleLoginDto {
  @ApiProperty({ example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6...' })
  @IsString()
  @IsNotEmpty()
  identityToken: string;

  @ApiPropertyOptional({ example: 'c1234567890.0.xyz' })
  @IsString()
  @IsOptional()
  authorizationCode?: string;

  @ApiPropertyOptional({ example: 'user@privaterelay.appleid.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'Alex Nguyễn' })
  @IsString()
  @IsOptional()
  name?: string;
}
