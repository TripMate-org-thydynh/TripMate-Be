import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GoogleLoginDto {
  @ApiProperty({ example: 'mock-google-token' })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiProperty({ example: 'alex@gmail.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Alex Nguyễn' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'https://lh3.googleusercontent.com/...' })
  @IsString()
  @IsOptional()
  avatarUrl?: string;
}
