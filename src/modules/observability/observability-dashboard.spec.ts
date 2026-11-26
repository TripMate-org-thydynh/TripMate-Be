import type { PrismaService } from '../../prisma/prisma.service';
import { MetricsBufferService } from './metrics-buffer.service';
import { ObservabilityService } from './observability.service';
import type { RequestFailuresService } from './request-failures.service';

jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: {
    EVERY_30_SECONDS: '*/30 * * * * *',
    EVERY_DAY_AT_3AM: '0 3 * * *',
    EVERY_HOUR: '0 * * * *',
  },
}));

describe('observability snapshots', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-26T12:00:45.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('preserves the maximum across multiple flushes of one metric bucket', async () => {
    let persistedMax = 0;
    const upsert = jest.fn().mockImplementation(({ create }) => {
      if (!persistedMax) persistedMax = create.maxLatencyMs;
      return Promise.resolve();
    });
    const updateMany = jest.fn().mockImplementation(({ where, data }) => {
      if (persistedMax < where.maxLatencyMs.lt)
        persistedMax = data.maxLatencyMs;
      return Promise.resolve();
    });
    const prisma = {
      requestMetric: { upsert, updateMany },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    } as unknown as PrismaService;
    const metrics = new MetricsBufferService(prisma);

    for (const durationMs of [120, 900, 200]) {
      metrics.record({
        route: '/api/v1/trips/:tripId',
        method: 'GET',
        statusCode: 200,
        durationMs,
      });
      await metrics.flush();
    }

    expect(persistedMax).toBe(900);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        bucketStart: new Date('2026-11-26T12:00:00.000Z'),
        route: '/api/v1/trips/:tripId',
        method: 'GET',
        statusClass: 2,
        maxLatencyMs: { lt: 900 },
      },
      data: { maxLatencyMs: 900 },
    });
  });

  it('uses the same window for totals, endpoint charts, routes and failure samples', async () => {
    const filter = { route: '/api/v1/trips/:tripId', method: 'GET' };
    const records = [
      { bucketStart: new Date('2026-11-26T11:58:00.000Z'), count: 2 },
      { bucketStart: new Date('2026-11-26T12:00:00.000Z'), count: 3 },
    ].map((entry) => ({
      ...entry,
      ...filter,
      statusClass: 5,
      maxLatencyMs: 50,
      sumLatencyMs: BigInt(entry.count * 50),
      le50: entry.count,
      le100: 0,
      le250: 0,
      le500: 0,
      le1000: 0,
      le2500: 0,
      le5000: 0,
      leInf: 0,
    }));
    const other = { ...records[0], method: 'POST', count: 10 };
    const findMany = jest.fn().mockResolvedValue([...records, other]);
    const prisma = {
      requestMetric: { findMany },
      sloTarget: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const recent = jest.fn().mockResolvedValue([]);
    const service = new ObservabilityService(prisma, {
      recent,
    } as unknown as RequestFailuresService);

    const dashboard = await service.getDashboard(3, 2, 'requests', filter);

    const gte = new Date('2026-11-26T11:58:00.000Z');
    const lte = new Date('2026-11-26T12:00:45.000Z');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { bucketStart: { gte, lte } },
    });
    expect(recent).toHaveBeenCalledWith(gte, lte, filter);
    expect(dashboard.overview.totalRequests).toBe(5);
    expect(
      dashboard.routes.map(({ method, requests }) => ({ method, requests })),
    ).toEqual([
      { method: 'POST', requests: 10 },
      { method: 'GET', requests: 5 },
    ]);
    expect(dashboard.timeseries.map(({ requests }) => requests)).toEqual([
      2, 3,
    ]);
    expect(dashboard.timeseries[1].p99Ms).toBeGreaterThanOrEqual(
      dashboard.timeseries[1].p95Ms,
    );
  });
});
