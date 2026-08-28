import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** Đăng nhập bằng username + mật khẩu. */
export class LoginPasswordDto {
  @ApiProperty({ example: 'minhnhat' })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: 'matkhau123' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
