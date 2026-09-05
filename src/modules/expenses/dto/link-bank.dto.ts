import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class LinkBankDto {
  @ApiProperty({ example: 'Vietcombank' })
  @IsString()
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({ example: '1234567890' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 20)
  accountNumber: string;

  @ApiProperty({ example: 'NGUYEN VAN A' })
  @IsString()
  @IsNotEmpty()
  accountHolder: string;
}
