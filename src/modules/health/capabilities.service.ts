import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const CAPABILITIES = ['matey', 'receiptOcr', 'receiptDrafts', 'publishTemplate'] as const;
export const CAPABILITY_MODES = ['enabled', 'readOnly', 'maintenance', 'hidden'] as const;
export type Capability = typeof CAPABILITIES[number];
export type CapabilityMode = typeof CAPABILITY_MODES[number];
type Policy = { mode: CapabilityMode; message: string; expiresAt: string | null; version: number };
const PREFIX = 'capability:';
const DEFAULT_POLICY: Policy = { mode: 'enabled', message: '', expiresAt: null, version: 0 };

@Injectable()
export class CapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  private decode(value?: string): Policy {
    if (!value) return DEFAULT_POLICY;
    try {
      const saved = JSON.parse(value) as Policy;
      if (CAPABILITY_MODES.includes(saved.mode) && Number.isInteger(saved.version) && saved.version > 0) return saved;
    } catch {
      // A malformed row leaves the capability in maintenance until an operator replaces it.
    }
    return { ...DEFAULT_POLICY, mode: 'maintenance' };
  }

  private effective(policy: Policy, now: number): Policy {
    return policy.expiresAt && Date.parse(policy.expiresAt) <= now
      ? { ...DEFAULT_POLICY, version: policy.version } : policy;
  }

  async getAll() {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: CAPABILITIES.map(key => PREFIX + key) } }, select: { key: true, value: true },
    });
    const now = Date.now();
    const policies = new Map(rows.map(({ key, value }) => [key, this.decode(value)]));
    return Object.fromEntries(CAPABILITIES.map(key => [
      key, this.effective(policies.get(PREFIX + key) ?? DEFAULT_POLICY, now),
    ]));
  }

  async get(key: Capability) {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: PREFIX + key }, select: { value: true },
    });
    return this.effective(this.decode(row?.value), Date.now());
  }

  async admin() {
    const [policies, history] = await Promise.all([
      this.getAll(),
      this.prisma.adminAuditLog.findMany({
        where: { targetType: 'featureCapability' }, orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, adminId: true, action: true, targetId: true, reason: true, details: true, createdAt: true },
      }),
    ]);
    return { policies, history };
  }

  async publish(key: Capability, input: Omit<Policy, 'version'>, expectedVersion: number, reason: string, adminId: string) {
    const configKey = PREFIX + key;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${configKey}))`;
      const previous = this.decode((await tx.systemConfig.findUnique({ where: { key: configKey } }))?.value);
      if (previous.version !== expectedVersion) throw new ConflictException('CAPABILITY_VERSION_CHANGED');
      const next = { ...input, version: previous.version + 1 };
      const value = JSON.stringify(next);
      await tx.systemConfig.upsert({
        where: { key: configKey }, update: { value }, create: { key: configKey, value },
      });
      await tx.adminAuditLog.create({ data: {
        adminId, action: 'CAPABILITY_PUBLISHED', targetType: 'featureCapability', targetId: key,
        reason, details: { previous, next },
      } });
      return next;
    });
  }
}
