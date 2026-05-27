import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SendOtpDto {
  @ApiProperty({ example: '+84987654321' })
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}
