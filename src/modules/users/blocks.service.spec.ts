import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BlocksService } from './blocks.service';

describe('BlocksService', () => {
  const me = '11111111-1111-1111-1111-111111111111';
  const other = '22222222-2222-2222-2222-222222222222';
  let prisma: any;
  let service: BlocksService;

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: other }) },
      userBlock: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ blockedId: other }]),
      },
    };
    service = new BlocksService(prisma);
  });

  it('chặn được người khác (idempotent qua upsert)', async () => {
    await expect(service.block(me, other)).resolves.toEqual({
      blocked: true,
      blockedId: other,
    });
    expect(prisma.userBlock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId_blockedId: { blockerId: me, blockedId: other } },
      }),
    );
  });

  it('không cho tự chặn mình', async () => {
    await expect(service.block(me, me)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.userBlock.upsert).not.toHaveBeenCalled();
  });

  it('báo 404 khi người bị chặn không tồn tại', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.block(me, other)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('bỏ chặn chỉ xoá dòng của chính mình', async () => {
    await service.unblock(me, other);
    expect(prisma.userBlock.deleteMany).toHaveBeenCalledWith({
      where: { blockerId: me, blockedId: other },
    });
  });

  it('blockedIds trả id người mình đã chặn', async () => {
    await expect(service.blockedIds(me)).resolves.toEqual([other]);
  });
});
