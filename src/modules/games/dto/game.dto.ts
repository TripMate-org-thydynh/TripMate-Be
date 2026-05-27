import { ApiProperty } from '@nestjs/swagger';
import { GameType } from '@prisma/client';
import { IsEnum, IsObject, IsNotEmpty } from 'class-validator';

export class CreateGameSessionDto {
  @ApiProperty({ enum: GameType })
  @IsEnum(GameType)
  gameType: GameType;

  @ApiProperty({ example: { currentTurn: 'userId', scores: {} } })
  @IsObject()
  @IsNotEmpty()
  initialState: object;
}

export class UpdateGameStateDto {
  @ApiProperty()
  @IsObject()
  @IsNotEmpty()
  stateJson: object;
}
