import { Request } from 'express';
import { User } from '@prisma/client';

/** Request đã qua JwtAuthGuard — `user` là bản ghi User từ DB. */
export interface RequestWithUser extends Request {
  user: User;
}
