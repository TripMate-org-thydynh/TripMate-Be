import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** Đăng ký nhanh chỉ với username + mật khẩu + xác nhận mật khẩu. */
export class RegisterPasswordDto {
  @ApiProperty({ example: 'minhnhat' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  username: string;

  @ApiProperty({ example: 'matkhau123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'matkhau123' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}
