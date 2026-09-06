import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../premium/entitlement.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import * as crypto from 'crypto';

function generateInviteCode(): string {
  return crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 10);
}

@Injectable()
export class InvitesService {
  constructor(
    private prisma: PrismaService,
    private entitlements: EntitlementService,
  ) {}

  async createInvite(tripId: string, userId: string, dto: CreateInviteDto) {
    // Verify member
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a trip member');

    let code: string;
    let attempts = 0;
    do {
      code = generateInviteCode();
      if (++attempts > 10) throw new Error('Could not generate unique code');
    } while (await this.prisma.tripInvite.findUnique({ where: { code } }));

    return this.prisma.tripInvite.create({
      data: {
        tripId,
        createdBy: userId,
        code,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        maxUses: dto.maxUses ?? null,
      },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async getInvites(tripId: string) {
    return this.prisma.tripInvite.findMany({
      where: { tripId, isActive: true },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deactivateInvite(inviteId: string, userId: string) {
    const invite = await this.prisma.tripInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    return this.prisma.tripInvite.update({
      where: { id: inviteId },
      data: { isActive: false },
    });
  }

  async joinByCode(code: string, userId: string) {
    const invite = await this.prisma.tripInvite.findUnique({
      where: { code },
      include: { trip: true },
    });

    if (!invite || !invite.isActive) {
      throw new NotFoundException('Invite link is invalid or inactive');
    }

    // Check expiry
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await this.prisma.tripInvite.update({
        where: { id: invite.id },
        data: { isActive: false },
      });
      throw new BadRequestException('Invite link has expired');
    }

    // Check use count
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      await this.prisma.tripInvite.update({
        where: { id: invite.id },
        data: { isActive: false },
      });
      throw new BadRequestException('Invite link has reached max uses');
    }

    // Check already member
    const existing = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId: invite.tripId, userId } },
    });
    if (existing) throw new BadRequestException('Already a trip member');

    // Hạn mức số thành viên — cùng chốt chặn như `TripsService.join()`.
    //
    // Đây là đường vào chuyến thứ hai. Chặn một đường mà bỏ đường kia thì hạn
    // mức chỉ là gợi ý: ai cũng lách được bằng cách dùng link mời thay vì mã.
    const members = await this.prisma.tripMember.count({
      where: { tripId: invite.tripId },
    });
    await this.entitlements.assertTripWithin(
      invite.tripId,
      'membersPerTrip',
      members,
    );

    // Add member & increment use count
    await this.prisma.$transaction([
      this.prisma.tripMember.create({
        data: { tripId: invite.tripId, userId, role: 'MEMBER' },
      }),
      this.prisma.tripInvite.update({
        where: { id: invite.id },
        data: {
          useCount: { increment: 1 },
          // Deactivate if single-use
          isActive:
            invite.maxUses !== null && invite.useCount + 1 >= invite.maxUses
              ? false
              : true,
        },
      }),
    ]);

    return this.prisma.trip.findUnique({
      where: { id: invite.tripId },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { members: true, moments: true } },
      },
    });
  }
}
