import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: '+84987654321' })
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @ApiProperty({ example: '1234' })
  @IsString()
  @IsNotEmpty()
  code: string;
}
