import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class AddCardDto {
  @ApiPropertyOptional({ example: '4242', description: '4 số cuối của thẻ' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}$/, {
    message: 'lastFour must be exactly 4 digits',
  })
  lastFour?: string;

  @ApiPropertyOptional({
    example: '4242',
    description: 'Chỉ nhận 4 số cuối hoặc chuỗi đã che (****4242)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(?:\*{4,15}\s*)?\d{4}$/, {
    message: 'Only last 4 digits or masked card number are accepted',
  })
  cardNumber?: string;

  @ApiPropertyOptional({
    example: 'VISA',
    enum: ['VISA', 'MASTERCARD', 'JCB', 'AMEX'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['VISA', 'MASTERCARD', 'JCB', 'AMEX'])
  type?: string;

  @ApiProperty({ example: '12/28' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/, {
    message: 'expiry must be in MM/YY format',
  })
  expiry: string;

  @ApiProperty({ example: 'NGUYEN VAN A' })
  @IsString()
  @IsNotEmpty()
  cardHolder: string;
}

