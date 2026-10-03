import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Đăng ký nhanh chỉ với username + mật khẩu + xác nhận mật khẩu. */
export class RegisterPasswordDto {
  // Username được ghép thành email nội bộ `<username>@tripmate.local`, nên chỉ
  // cho ký tự an toàn — không khoảng trắng, không '@', không ký tự điều khiển.
  @ApiProperty({ example: 'minhnhat' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_.]{3,30}$/, {
    message: 'Username chỉ gồm chữ, số, dấu chấm, gạch dưới (3–30 ký tự)',
  })
  username: string;

  // bcrypt chỉ dùng 72 byte đầu; chặn trên để không ai gửi mật khẩu hàng MB.
  @ApiProperty({ example: 'matkhau123' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' })
  @MaxLength(72)
  password: string;

  @ApiProperty({ example: 'matkhau123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  confirmPassword: string;
}
