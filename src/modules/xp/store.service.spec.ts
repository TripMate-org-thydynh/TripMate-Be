import { BadRequestException } from '@nestjs/common';
import { StoreService } from './store.service';
import { STICKER_CATALOG, THEME_CATALOG } from './store.catalog';

describe('StoreService (CONC-02)', () => {
  it('serializes concurrent purchaseSticker calls in $transaction so XP is only spent once', async () => {
    const sticker = STICKER_CATALOG[0];
    const owned = new Set<string>();
    let lockChain = Promise.resolve();

    const txMock: any = {
      $queryRaw: jest.fn(),
      userSticker: {
        findUnique: jest.fn(({ where }: any) => {
          const key = `${where.userId_stickerId.userId}:${where.userId_stickerId.stickerId}`;
          return Promise.resolve(owned.has(key) ? { id: key } : null);
        }),
        create: jest.fn(({ data }: any) => {
          const key = `${data.userId}:${data.stickerId}`;
          owned.add(key);
          return Promise.resolve(data);
        }),
      },
    };

    const prismaMock: any = {
      $transaction: jest.fn((fn: any) => {
        const next = lockChain.then(() => fn(txMock));
        lockChain = next.catch(() => undefined);
        return next;
      }),
    };

    const xpMock: any = {
      spend: jest.fn().mockResolvedValue({ balance: 420 }),
    };

    const service = new StoreService(prismaMock, xpMock);

    const [first, second] = await Promise.allSettled([
      service.purchaseSticker('user-1', sticker.id),
      service.purchaseSticker('user-1', sticker.id),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.reason).toBeInstanceOf(BadRequestException);
    }
    expect(xpMock.spend).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent purchaseTheme calls in $transaction so XP is only spent once', async () => {
    const paidTheme = THEME_CATALOG.find((t) => t.priceXp > 0)!;
    const owned = new Set<string>();
    let lockChain = Promise.resolve();

    const txMock: any = {
      $queryRaw: jest.fn(),
      userTheme: {
        findUnique: jest.fn(({ where }: any) => {
          const key = `${where.userId_themeId.userId}:${where.userId_themeId.themeId}`;
          return Promise.resolve(owned.has(key) ? { id: key } : null);
        }),
        create: jest.fn(({ data }: any) => {
          const key = `${data.userId}:${data.themeId}`;
          owned.add(key);
          return Promise.resolve(data);
        }),
      },
    };

    const prismaMock: any = {
      $transaction: jest.fn((fn: any) => {
        const next = lockChain.then(() => fn(txMock));
        lockChain = next.catch(() => undefined);
        return next;
      }),
    };

    const xpMock: any = {
      spend: jest.fn().mockResolvedValue({ balance: 300 }),
    };

    const service = new StoreService(prismaMock, xpMock);

    const [first, second] = await Promise.allSettled([
      service.purchaseTheme('user-1', paidTheme.id),
      service.purchaseTheme('user-1', paidTheme.id),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(xpMock.spend).toHaveBeenCalledTimes(1);
  });
});
