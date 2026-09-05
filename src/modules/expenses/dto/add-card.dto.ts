import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class AddCardDto {
  @ApiProperty({ example: '4242424242424242' })
  @IsString()
  @IsNotEmpty()
  @Length(12, 19)
  cardNumber: string;

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

  @ApiProperty({ example: '123' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 4)
  cvv: string;
}
