import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Máy báo token FCM của nó cho server sau khi đăng nhập. */
export class RegisterDeviceDto {
  @ApiProperty({ description: 'Token FCM của máy' })
  @IsString()
  @IsNotEmpty()
  // Token FCM thật dài ~160 ký tự; chặn trên để không ai nhét rác vào DB.
  @MaxLength(4096)
  token: string;

  @ApiPropertyOptional({ enum: ['android', 'ios', 'web'] })
  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: string;
}
