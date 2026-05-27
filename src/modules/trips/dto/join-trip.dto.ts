import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class JoinTripDto {
  @ApiProperty({ example: 'DALAT6' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Invite code must be exactly 6 characters' })
  inviteCode: string;
}
