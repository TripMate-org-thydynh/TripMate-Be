import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SubmitCorrectionDto {
  @ApiProperty({
    example: 'Tiệm Cà Phê Túi Mơ To',
    description: 'Tên riêng để biết khi nào cần chèn đính chính vào prompt.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'Đã chuyển sang 12 Trần Hưng Đạo từ 09/2026.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  correction: string;
}
