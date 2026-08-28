import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * DTO cho endpoint import vé.
 * Hỗ trợ 2 mode:
 *  - text: dán nội dung email/xác nhận văn bản
 *  - image: gửi ảnh base64 + mimeType (vé chụp / PDF screenshot)
 * Một trong 2 phải có mặt.
 */
export class ImportReservationDto {
  /** Text xác nhận (email, paste thủ công). */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  /** Ảnh vé / PDF (base64). Bắt buộc khi không có text. */
  @ValidateIf((o) => !o.text)
  @IsNotEmpty()
  @IsString()
  imageBase64?: string;

  /** MIME type của ảnh (mặc định image/jpeg). */
  @IsOptional()
  @IsString()
  mimeType?: string;
}
