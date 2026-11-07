import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class BlockUserDto {
  @ApiProperty({ description: 'Id người bị chặn' })
  @IsUUID()
  blockedId: string;
}
