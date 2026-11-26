import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 10_000;
const MAX_PENDING = 200;

@Injectable()
export class RequestFailuresService {
  private readonly logger = new Logger(RequestFailuresService.name);
  private pending: Prisma.RequestFailureCreateManyInput[] = [];
  private flushing = false;

  constructor(private readonly prisma: PrismaService) {}

  record(event: Prisma.RequestFailureCreateManyInput) {
    if (this.pending.length === MAX_PENDING) this.pending.shift();
    this.pending.push(event);
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'request-failures-flush' })
  async flush() {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const current = this.pending;
    this.pending = [];
    try {
      await this.prisma.$transaction(
        [
          this.prisma.requestFailure.createMany({
            data: current,
            skipDuplicates: true,
          }),
          this.prisma.$executeRaw`
          DELETE FROM "request_failures"
          WHERE "id" IN (
            SELECT "id" FROM "request_failures"
            ORDER BY "occurred_at" DESC, "id" DESC
            OFFSET ${MAX_SAMPLES}
          )
        `,
        ],
        { isolationLevel: 'Serializable' },
      );
    } catch {
      this.pending = [...current, ...this.pending].slice(-MAX_PENDING);
      this.logger.warn('Could not persist request failure samples.');
    } finally {
      this.flushing = false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'request-failures-retention' })
  async pruneExpired() {
    try {
      await this.prisma.requestFailure.deleteMany({
        where: { occurredAt: { lt: new Date(Date.now() - RETENTION_MS) } },
      });
    } catch {
      this.logger.warn('Could not prune expired request failure samples.');
    }
  }

  recent(start: Date, end: Date, filter?: { route: string; method: string }) {
    return this.prisma.requestFailure.findMany({
      where: {
        ...filter,
        occurredAt: {
          gte: new Date(
            Math.max(start.getTime(), end.getTime() - RETENTION_MS),
          ),
          lte: end,
        },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        occurredAt: true,
        route: true,
        method: true,
        statusCode: true,
        durationMs: true,
      },
    });
  }
}
