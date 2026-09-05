import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class UpdateTodoDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH'])
  priority?: string;

  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;

  @IsOptional()
  @IsISO8601()
  dueDate?: string | null;

  /** Client sends the last-known updatedAt for optimistic concurrency. Optional for backward compat. */
  @IsOptional()
  @IsISO8601()
  updatedAt?: string;
}
