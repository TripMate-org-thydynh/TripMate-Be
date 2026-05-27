import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: '3f45a2b1-uuid-from-supabase' })
  @IsString()
  @IsNotEmpty()
  supabaseId: string;
}
