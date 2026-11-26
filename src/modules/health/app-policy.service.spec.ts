import type { PrismaService } from '../../prisma/prisma.service';
import { AppPolicyService, type SaveAppPolicyDto } from './app-policy.service';

describe('AppPolicyService', () => {
  const rows = new Map<string, string>();
  const history = jest.fn().mockResolvedValue([]);
  const recordAudit = jest.fn();
  const store = {
    findMany: jest.fn(async () =>
      [...rows].map(([key, value]) => ({ key, value })),
    ),
    upsert: jest.fn(
      async ({ create }: { create: { key: string; value: string } }) => {
        rows.set(create.key, create.value);
      },
    ),
  };
  const client = {
    systemConfig: store,
    adminAuditLog: { findMany: history, create: recordAudit },
  };
  const prisma = {
    ...client,
    $transaction: jest.fn((run: (tx: typeof client) => unknown) => run(client)),
  };
  const service = new AppPolicyService(prisma as unknown as PrismaService);
  const policy: SaveAppPolicyDto = {
    channel: 'play',
    minVersion: '1.2.9',
    latestVersion: '1.2.10',
    updateUrl: 'https://play.google.com/store/apps/details?id=com.tripmate.app',
    maintenance: false,
    reason: 'Publish the current release',
  };

  beforeEach(() => {
    rows.clear();
    jest.clearAllMocks();
  });

  it('publishes a channel policy without exposing audit fields in public responses', async () => {
    await service.publish(policy, 'admin-id');
    expect(await service.get('play')).toMatchObject({
      minVersion: '1.2.9',
      latestVersion: '1.2.10',
      updateUrl: policy.updateUrl,
    });
    expect(await service.get('play')).not.toHaveProperty('reason');
    expect(recordAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-id',
        reason: policy.reason,
      }),
    });
    expect(await service.get('direct')).toMatchObject({ updateUrl: null });
  });

  it('applies global maintenance to channels with saved overrides', async () => {
    const current = await service.get();
    await service.publish(policy, 'admin-id');
    await service.publish(
      {
        ...policy,
        channel: 'default',
        minVersion: current.minVersion,
        latestVersion: current.latestVersion,
        maintenance: true,
        maintenanceMessage: 'Back soon.',
        updateUrl: null,
      },
      'admin-id',
    );
    expect(await service.get('play')).toMatchObject({
      maintenance: true,
      maintenanceMessage: 'Back soon.',
      latestVersion: policy.latestVersion,
    });
  });

  it('rejects a new mandatory version without a download URL', async () => {
    await expect(
      service.publish(
        {
          ...policy,
          channel: 'direct',
          updateUrl: null,
          minVersion: '999999.0.0',
          latestVersion: '999999.0.0',
        },
        'admin-id',
      ),
    ).rejects.toThrow('Configure a download URL');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects invalid version order and a URL outside the release store', async () => {
    await expect(
      service.publish({ ...policy, minVersion: '1.2.11' }, 'admin-id'),
    ).rejects.toThrow('Minimum version');
    await expect(
      service.publish(
        { ...policy, updateUrl: 'https://example.com' },
        'admin-id',
      ),
    ).rejects.toThrow('valid HTTPS update URL');
    await expect(
      service.publish(
        { ...policy, updateUrl: 'https://play.google.com/store' },
        'admin-id',
      ),
    ).rejects.toThrow('valid HTTPS update URL');
  });
});
