import { ApiPropertyOptional } from '@nestjs/swagger';
import { MessageType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class SendMessageDto {
  @ApiPropertyOptional({ example: 'Anh em đang ở đâu vậy? 👀' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() mediaUrl?: string;

  @ApiPropertyOptional({ enum: MessageType, default: 'TEXT' })
  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType;

  @ApiPropertyOptional() @IsOptional() @IsUUID() replyToId?: string;
}

export class ReactionDto {
  @ApiPropertyOptional({ example: '❤️' })
  @IsString()
  emoji: string;
}
