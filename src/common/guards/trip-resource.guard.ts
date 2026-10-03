import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';

export const IN_TRIP_KEY = 'inTripResource';

interface InTripMeta {
  model: string;
  paramName: string;
}

/**
 * Model → cách lấy tripId của bản ghi. `null` nghĩa là model có sẵn cột
 * `tripId`; chuỗi là tên quan hệ cha mang `tripId` (vd. pollOption → poll).
 * Chỉ model có trong bảng này mới dùng được với `@InTrip`.
 */
const TRIP_PATH: Record<string, string | null> = {
  moment: null,
  journalEntry: null,
  gameSession: null,
  packingItem: null,
  todoItem: null,
  reservation: null,
  wishlistItem: null,
  chatMessage: null,
  tripInvite: null,
  tripNote: null,
  expense: null,
  pollOption: 'poll',
};

/**
 * Xác nhận tài nguyên con trên URL thuộc đúng chuyến `:tripId`.
 *
 * TripMemberGuard chỉ chứng minh người gọi là thành viên của `:tripId`. Nếu
 * handler sau đó thao tác theo `id` trần, thành viên chuyến A đọc/sửa được tài
 * nguyên chuyến B bằng cách gọi `/trips/A/<loại>/<id của B>`. Guard này chặn ở
 * một chỗ, không phụ thuộc từng service có nhớ lọc `tripId` hay không.
 *
 * Trả 404 (không phải 403) để không tiết lộ id nào đang tồn tại ở chuyến khác.
 */
@Injectable()
export class TripResourceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<InTripMeta>(
      IN_TRIP_KEY,
      context.getHandler(),
    );
    if (!meta) return true;

    const request = context.switchToHttp().getRequest();
    const tripId: string | undefined = request.params.tripId;
    const resourceId: string | undefined = request.params[meta.paramName];
    if (!tripId || !resourceId) {
      throw new ForbiddenException('errors.auth.forbidden');
    }

    if (!(meta.model in TRIP_PATH)) {
      throw new InternalServerErrorException(
        `Model ${meta.model} chưa được khai báo trong TRIP_PATH`,
      );
    }
    const via = TRIP_PATH[meta.model];
    const delegate = (this.prisma as any)[meta.model];
    if (!delegate?.findUnique) {
      throw new InternalServerErrorException(
        `Prisma delegate cho model ${meta.model} không hợp lệ`,
      );
    }

    const row = await delegate.findUnique({
      where: { id: resourceId },
      select: via ? { [via]: { select: { tripId: true } } } : { tripId: true },
    });
    const actualTripId: string | undefined = via
      ? row?.[via]?.tripId
      : row?.tripId;

    if (!row || actualTripId !== tripId) {
      throw new NotFoundException('errors.database.notFound');
    }
    return true;
  }
}

/**
 * Gắn lên handler có id tài nguyên con: `@InTrip('moment', 'id')`.
 * Chạy sau các guard cấp class (JwtAuthGuard, TripMemberGuard).
 */
export const InTrip = (model: string, paramName = 'id') =>
  applyDecorators(
    SetMetadata(IN_TRIP_KEY, { model, paramName }),
    UseGuards(TripResourceGuard),
  );
