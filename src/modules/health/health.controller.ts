import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Kiểm tra trạng thái hoạt động của hệ thống (Uptime / Health Check)',
  })
  async check() {
    let dbStatus = 'UP';
    let redisStatus = 'UP';

    // 1. Verify Database Connection
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'DOWN';
    }

    // 2. Verify Redis Cache Connection
    try {
      await this.cache.set('health_check', 'ok', 5000);
      const val = await this.cache.get('health_check');
      if (val !== 'ok') {
        redisStatus = 'DOWN';
      }
    } catch {
      redisStatus = 'DOWN';
    }

    const overallStatus =
      dbStatus === 'UP' && redisStatus === 'UP' ? 'OK' : 'DEGRADED';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
  }
}
