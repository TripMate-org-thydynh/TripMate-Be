import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: '3f45a2b1-uuid-from-supabase' })
  @IsString()
  @IsNotEmpty()
  supabaseId: string;

  @ApiProperty({ example: 'supabase-jwt-access-token', required: false })
  @IsString()
  @IsOptional()
  accessToken?: string;
}
