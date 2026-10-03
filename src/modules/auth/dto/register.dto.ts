import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterDto {
  /// Vé đăng ký do `/auth/verify-otp` hoặc `/auth/google` cấp sau khi đã
  /// chứng minh quyền sở hữu email/số điện thoại. Email và supabaseId của tài
  /// khoản mới lấy từ vé này, KHÔNG lấy từ body — nếu không, ai cũng tạo được
  /// tài khoản dưới email người khác rồi chờ họ đăng nhập vào đúng tài khoản đó.
  @ApiProperty({ example: 'eyJhbGciOi...' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  registrationToken: string;

  /// Giữ lại cho client cũ còn gửi lên; server bỏ qua, dùng giá trị trong vé.
  @ApiPropertyOptional({ example: 'alex@tripmate.com or +84912345678' })
  @IsString()
  @IsOptional()
  @MaxLength(254)
  email?: string;

  @ApiProperty({ example: 'Alex Nguyễn' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'alexnguyen' })
  @IsString()
  @IsOptional()
  @Matches(/^[a-zA-Z0-9_.]{3,30}$/, {
    message: 'Username chỉ gồm chữ, số, dấu chấm, gạch dưới (3–30 ký tự)',
  })
  username?: string;

  /// Giữ lại cho client cũ; server bỏ qua, dùng giá trị trong vé.
  @ApiPropertyOptional({ example: '3f45a2b1-uuid-from-supabase' })
  @IsString()
  @IsOptional()
  @MaxLength(254)
  supabaseId?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  @Matches(/^https:\/\//, { message: 'avatarUrl phải là đường dẫn https' })
  avatarUrl?: string;
}
