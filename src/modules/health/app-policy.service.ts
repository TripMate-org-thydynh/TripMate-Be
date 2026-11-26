import { BadRequestException, Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';

export const APP_POLICY_PREFIX = 'release_policy:';
export const POLICY_CHANNELS = [
  'default',
  'play',
  'appstore',
  'direct',
  'web',
] as const;
type Channel = (typeof POLICY_CHANNELS)[number];
type Policy = Omit<SaveAppPolicyDto, 'channel' | 'reason'>;
const VERSION =
  /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const TARGET = 'APP_RELEASE_POLICY';

export class SaveAppPolicyDto {
  @IsIn(POLICY_CHANNELS)
  channel: Channel;

  @IsString()
  @Matches(VERSION)
  minVersion: string;

  @IsString()
  @Matches(VERSION)
  latestVersion: string;

  @IsBoolean()
  maintenance: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  maintenanceMessage?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  updateUrl?: string | null;

  @IsString()
  @MaxLength(300)
  reason: string;
}

function compareVersions(left: string, right: string): number {
  const [major, minor, patch] = left.split('.').map(Number);
  const [otherMajor, otherMinor, otherPatch] = right.split('.').map(Number);
  return major - otherMajor || minor - otherMinor || patch - otherPatch;
}

function isDownloadUrl(url: URL, channel: Channel): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    return false;
  if (channel === 'play') {
    return (
      url.hostname === 'play.google.com' &&
      url.pathname === '/store/apps/details' &&
      url.searchParams.get('id') === 'com.tripmate.app'
    );
  }
  if (channel === 'appstore') {
    return (
      url.hostname === 'apps.apple.com' &&
      /\/app\/(?:[^/]+\/)?id[0-9]+\/?$/.test(url.pathname)
    );
  }
  return true;
}

@Injectable()
export class AppPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  private async policies(
    db: Pick<PrismaService, 'systemConfig'> = this.prisma,
  ) {
    const records = await db.systemConfig.findMany({
      where: { key: { startsWith: APP_POLICY_PREFIX } },
      select: { key: true, value: true },
    });
    return new Map(
      records.map((row) => [
        row.key.slice(APP_POLICY_PREFIX.length),
        JSON.parse(row.value) as Policy,
      ]),
    );
  }

  private resolve(channel: Channel, policies: Map<string, Policy>) {
    const defaults = policies.get('default') ?? {
      minVersion: process.env.APP_MIN_VERSION || '1.0.0',
      latestVersion:
        process.env.APP_LATEST_VERSION ||
        process.env.APP_MIN_VERSION ||
        '1.0.0',
      maintenance: process.env.APP_MAINTENANCE === 'true',
      maintenanceMessage: process.env.APP_MAINTENANCE_MESSAGE || null,
    };
    const selected = policies.get(channel) ?? defaults;
    const storeUrl = {
      ios:
        policies.get('appstore')?.updateUrl ??
        (process.env.APP_STORE_URL_IOS || null),
      android:
        policies.get('play')?.updateUrl ??
        (process.env.APP_STORE_URL_ANDROID ||
          'https://play.google.com/store/apps/details?id=com.tripmate.app'),
    };
    const candidate =
      policies.get(channel)?.updateUrl ??
      (channel === 'appstore'
        ? storeUrl.ios
        : channel === 'play'
          ? storeUrl.android
          : null);
    const url =
      candidate && URL.canParse(candidate) ? new URL(candidate) : null;
    return {
      minVersion: selected.minVersion,
      latestVersion: selected.latestVersion,
      maintenance: defaults.maintenance || selected.maintenance,
      maintenanceMessage: defaults.maintenance
        ? defaults.maintenanceMessage
        : selected.maintenanceMessage,
      storeUrl,
      updateUrl: url && isDownloadUrl(url, channel) ? url.toString() : null,
    };
  }

  async get(header?: string) {
    const channel =
      POLICY_CHANNELS.find((item) => item === header) ?? 'default';
    return this.resolve(channel, await this.policies());
  }

  async adminOverview(channel: Channel) {
    const [policies, history] = await Promise.all([
      this.policies(),
      this.prisma.adminAuditLog.findMany({
        where: { targetType: TARGET, targetId: channel },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          reason: true,
          details: true,
          admin: { select: { name: true } },
        },
      }),
    ]);
    const inherited = new Map(policies);
    inherited.delete(channel);
    return {
      saved: policies.get(channel) ?? null,
      effective: this.resolve(channel, policies),
      globalMaintenance: this.resolve('default', policies).maintenance,
      fallbackUpdateUrl: this.resolve(channel, inherited).updateUrl,
      history,
    };
  }

  async publish(dto: SaveAppPolicyDto, adminId: string) {
    const reason = dto.reason.trim();
    const maintenanceMessage = dto.maintenanceMessage?.trim() || null;
    if (!reason)
      throw new BadRequestException('Provide a reason for this change.');
    if (compareVersions(dto.minVersion, dto.latestVersion) > 0) {
      throw new BadRequestException(
        'Minimum version must not exceed the latest version.',
      );
    }
    let updateUrl = dto.updateUrl?.trim() || null;
    if (updateUrl) {
      try {
        const url = new URL(updateUrl);
        if (!isDownloadUrl(url, dto.channel)) throw new Error();
        updateUrl = url.toString();
      } catch {
        throw new BadRequestException(
          'Use a valid HTTPS update URL for the selected channel.',
        );
      }
    }
    const policy = {
      minVersion: dto.minVersion,
      latestVersion: dto.latestVersion,
      maintenance: dto.maintenance,
      maintenanceMessage,
      updateUrl,
    };
    await this.prisma.$transaction(
      async (tx) => {
        const key = APP_POLICY_PREFIX + dto.channel;
        const current = await this.policies(tx);
        const next = new Map(current).set(dto.channel, policy);
        for (const channel of POLICY_CHANNELS.slice(1)) {
          const before = this.resolve(channel, current);
          const after = this.resolve(channel, next);
          if (
            !after.updateUrl &&
            (before.updateUrl ||
              compareVersions(after.minVersion, before.minVersion) > 0)
          ) {
            throw new BadRequestException(
              'Configure a download URL for each affected release channel before forcing an update.',
            );
          }
        }
        const value = JSON.stringify(policy);
        await tx.systemConfig.upsert({
          where: { key },
          create: { key, value, description: 'Mobile release policy' },
          update: { value },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId,
            action: 'PUBLISH',
            targetType: TARGET,
            targetId: dto.channel,
            reason,
            details: policy,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
    return this.adminOverview(dto.channel);
  }
}
