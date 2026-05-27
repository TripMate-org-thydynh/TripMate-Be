import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'alex@tripmate.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Alex Nguyễn' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'alexnguyen' })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiProperty({ example: '3f45a2b1-uuid-from-supabase' })
  @IsString()
  @IsNotEmpty()
  supabaseId: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsString()
  @IsOptional()
  avatarUrl?: string;
}
