import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { AnnouncementCampaign, CampaignDelivery, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CampaignDraftDto, CampaignPublishDto } from './dto/campaign.dto';
import { isRetryablePushError, PushService } from './push.service';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private working = false;

  constructor(private readonly prisma: PrismaService, private readonly push: PushService) {}

  async list() {
    const campaigns = await this.prisma.announcementCampaign.findMany({
      orderBy: { createdAt: 'desc' }, take: 30,
      include: { _count: { select: { deliveries: true } } },
    });
    const groups = await this.prisma.campaignDelivery.groupBy({
      by: ['campaignId'], where: { campaignId: { in: campaigns.map(row => row.id) }, inAppAt: { not: null } },
      _count: true, _sum: { pushAccepted: true },
    });
    const counts = new Map(groups.map(group => [group.campaignId, group]));
    const now = new Date();
    return campaigns.map(row => ({
      ...row, recipientCount: row._count.deliveries,
      expired: row.endsAt <= now,
      inAppCount: counts.get(row.id)?._count ?? 0,
      pushAccepted: counts.get(row.id)?._sum.pushAccepted ?? 0,
    }));
  }

  private details(dto: CampaignDraftDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (!(endsAt > startsAt && endsAt.getTime() > Date.now())) throw new BadRequestException('CAMPAIGN_INVALID_WINDOW');
    let imageUrl: string | null = null;
    if (dto.imageUrl?.trim()) {
      try {
        const image = new URL(dto.imageUrl);
        if (image.protocol !== 'https:' || image.hostname !== 'res.cloudinary.com' ||
            image.username || image.password || image.port || !image.pathname.includes('/image/upload/')) throw new Error();
        imageUrl = image.href;
      } catch {
        throw new BadRequestException('CAMPAIGN_IMAGE_MUST_BE_CLOUDINARY_HTTPS');
      }
    }
    return { ...dto, title: dto.title.trim(), body: dto.body.trim(), imageUrl, startsAt, endsAt };
  }

  async save(id: string | null, dto: CampaignDraftDto, adminId: string) {
    const data = this.details(dto);
    return this.prisma.$transaction(async tx => {
      if (id && (await this.lock(tx, id)).status !== 'DRAFT') {
        throw new ConflictException('CAMPAIGN_NOT_EDITABLE');
      }
      const campaign = id
        ? await tx.announcementCampaign.update({ where: { id, status: 'DRAFT' }, data })
        : await tx.announcementCampaign.create({ data });
      await this.audit(tx, adminId, 'CAMPAIGN_SAVED', campaign.id, 'Lưu bản nháp', {});
      return campaign;
    });
  }

  private async lock(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<unknown[]>`
      SELECT id FROM announcement_campaigns WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException();
    return tx.announcementCampaign.findUniqueOrThrow({ where: { id } });
  }

  private audit(tx: Prisma.TransactionClient, adminId: string, action: string, targetId: string,
    reason: string, details: Prisma.InputJsonValue) {
    return tx.adminAuditLog.create({
      data: { adminId, action, targetType: 'announcementCampaign', targetId, reason, details },
    });
  }

  async schedule(id: string, dto: CampaignPublishDto, adminId: string) {
    return this.prisma.$transaction(async tx => {
      const campaign = await this.lock(tx, id);
      if (campaign.status !== 'DRAFT' || campaign.endsAt.getTime() <= Date.now()) {
        throw new ConflictException('CAMPAIGN_NOT_SCHEDULABLE');
      }
      const recipients = await tx.user.findMany({
        where: {
          id: { in: dto.userIds }, deletedAt: null, isLocked: false,
          ...(campaign.platform === 'all' ? {} : { deviceTokens: { some: { platform: campaign.platform } } }),
        },
        select: { id: true },
      });
      if (!recipients.length) throw new BadRequestException('CAMPAIGN_NO_RECIPIENTS');
      await tx.campaignDelivery.createMany({
        data: recipients.map(user => ({ userId: user.id, campaignId: id, nextAttempt: campaign.startsAt })),
      });
      await tx.announcementCampaign.update({ where: { id }, data: { status: 'SCHEDULED' } });
      await this.audit(tx, adminId, 'CAMPAIGN_SCHEDULED', id, dto.reason.trim(), {
        recipientCount: recipients.length, requestedCount: dto.userIds.length,
      });
      return { recipientCount: recipients.length };
    });
  }

  async stop(id: string, reason: string, adminId: string) {
    return this.prisma.$transaction(async tx => {
      const previous = await this.lock(tx, id);
      if (previous.status === 'STOPPED') return previous;
      const saved = await tx.announcementCampaign.update({ where: { id }, data: { status: 'STOPPED' } });
      await this.audit(tx, adminId, 'CAMPAIGN_STOPPED', id, reason, {});
      return saved;
    });
  }

  async sendTest(id: string, adminId: string) {
    const campaign = await this.prisma.announcementCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException();
    const title = '[Thử] ' + campaign.title;
    await this.prisma.notification.create({
      data: { userId: adminId, title, body: campaign.body, type: 'TRIP_UPDATE' },
    });
    const result = campaign.push ? await this.push.sendToUsers([adminId], { title, body: campaign.body }) : null;
    await this.audit(this.prisma, adminId, 'CAMPAIGN_TESTED', id, 'Gửi thử cho tài khoản quản trị hiện tại', {});
    return { inApp: 1, pushAccepted: result?.delivered ?? 0 };
  }

  @Interval(15_000)
  async process() {
    if (this.working) return;
    this.working = true;
    try {
      const now = new Date();
      const due = await this.prisma.campaignDelivery.findMany({
        where: { completedAt: null, nextAttempt: { lte: now },
          campaign: { status: 'SCHEDULED', startsAt: { lte: now }, endsAt: { gt: now } } },
        orderBy: { nextAttempt: 'asc' }, take: 20,
      });
      for (const delivery of due) {
        try {
          await this.deliver(delivery);
        } catch (error) {
          this.logger.warn('Could not process campaign recipient', error);
        }
      }
    } catch (error) {
      this.logger.warn('Campaign worker failed', error);
    } finally {
      this.working = false;
    }
  }

  private async deliver(row: CampaignDelivery) {
    const now = new Date();
    const leasedUntil = new Date(now.getTime() + 120_000);
    const campaign = await this.prisma.$transaction(async tx => {
      const campaign = await this.lock(tx, row.campaignId);
      if (campaign.status !== 'SCHEDULED' || campaign.endsAt <= now) return null;
      const claim = await tx.campaignDelivery.updateMany({
        where: { id: row.id, completedAt: null, nextAttempt: row.nextAttempt },
        data: { nextAttempt: leasedUntil, attempts: { increment: 1 } },
      });
      if (!claim.count) return null;
      if (!row.inAppAt) {
        await tx.notification.create({ data: {
          id: row.id, userId: row.userId, title: campaign.title, body: campaign.body, type: 'TRIP_UPDATE',
          data: { campaignId: campaign.id, cta: campaign.cta },
        } });
        await tx.campaignDelivery.update({ where: { id: row.id }, data: { inAppAt: now } });
      }
      return campaign;
    });
    if (!campaign) return;
    try {
      const accepted = campaign.push ? (await this.push.sendToUsers([row.userId], {
        title: campaign.title, body: campaign.body, data: { notificationId: row.id, campaignId: campaign.id },
      }, campaign.platform === 'all' ? undefined : campaign.platform, { retryIfNoneAccepted: true })).delivered : 0;
      await this.prisma.campaignDelivery.updateMany({ where: { id: row.id, nextAttempt: leasedUntil },
        data: { completedAt: new Date(), pushAccepted: accepted } });
    } catch (error) {
      const failure = error as { code?: string; response?: { headers?: Record<string, string> } };
      const retryAfter = failure?.response?.headers?.['retry-after'];
      const nowMs = Date.now();
      const providerTime = retryAfter && /^\d+$/.test(retryAfter)
        ? nowMs + Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? '');
      const backoff = 60_000 * 2 ** row.attempts + Math.floor(Math.random() * 5000);
      const nextAttempt = new Date(Math.max(nowMs + backoff, providerTime || 0));
      await this.prisma.campaignDelivery.updateMany({ where: { id: row.id, nextAttempt: leasedUntil },
        data: isRetryablePushError(failure?.code) && row.attempts < 2 && nextAttempt < campaign.endsAt
          ? { nextAttempt } : { completedAt: new Date() } });
    }
  }

  async claimPopup(userId: string) {
    const now = new Date();
    const localMidnight = new Date(Math.floor((now.getTime() + 25_200_000) / 86_400_000) * 86_400_000 - 25_200_000);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'campaign-popup:' + userId}))`;
      if (await tx.campaignDelivery.count({ where: { userId, shownAt: { gte: localMidnight } } })) return null;
      const row = await tx.campaignDelivery.findFirst({
        where: { userId, shownAt: null, inAppAt: { not: null },
          campaign: { popup: true, status: 'SCHEDULED', startsAt: { lte: now }, endsAt: { gt: now } } },
        orderBy: { inAppAt: 'desc' }, include: { campaign: true },
      });
      if (!row) return null;
      await tx.campaignDelivery.update({ where: { id: row.id }, data: { shownAt: now } });
      const { id, title, body, imageUrl, cta }: AnnouncementCampaign = row.campaign;
      return { id, title, body, imageUrl, cta };
    });
  }
}
