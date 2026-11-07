import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'ban@gmail.com' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  identifier: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'Mã OTP gồm 6 chữ số' })
  code: string;

  // Cùng luật với register-password để mật khẩu đặt lại không yếu hơn.
  @ApiProperty({ example: 'matkhau-moi-123' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' })
  @MaxLength(72)
  newPassword: string;
}
