import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { JoinTripDto } from './dto/join-trip.dto';

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join('');
}

@Injectable()
export class TripsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateTripDto) {
    let inviteCode: string;
    let attempts = 0;
    do {
      inviteCode = generateInviteCode();
      if (++attempts > 10)
        throw new Error('Could not generate unique invite code');
    } while (await this.prisma.trip.findUnique({ where: { inviteCode } }));

    return this.prisma.trip.create({
      data: {
        name: dto.name,
        description: dto.description,
        destination: dto.destination,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        coverImage: dto.coverImage,
        currency: dto.currency ?? 'VND',
        budget: dto.budget,
        vibe: dto.vibe,
        theme: dto.theme,
        isPublic: dto.isPublic ?? false,
        inviteCode,
        createdBy: userId,
        members: { create: { userId, role: 'CREATOR' } },
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        _count: { select: { members: true } },
      },
    });
  }

  async findOne(tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId, deletedAt: null },
      include: {
        creator: { select: { id: true, name: true, avatarUrl: true } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                avatarUrl: true,
                presence: true,
              },
            },
          },
        },
        _count: {
          select: { moments: true, expenses: true, chatMessages: true },
        },
      },
    });
    if (!trip) throw new NotFoundException('errors.trips.notFound');
    return trip;
  }

  async update(tripId: string, userId: string, dto: UpdateTripDto) {
    await this.ensureCreator(tripId, userId);
    return this.prisma.trip.update({
      where: { id: tripId },
      data: {
        name: dto.name,
        description: dto.description,
        destination: dto.destination,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        coverImage: dto.coverImage,
        currency: dto.currency,
        budget: dto.budget,
        vibe: dto.vibe,
        theme: dto.theme,
        isPublic: dto.isPublic,
      },
    });
  }

  async delete(tripId: string, userId: string) {
    await this.ensureCreator(tripId, userId);
    return this.prisma.trip.update({
      where: { id: tripId },
      data: { deletedAt: new Date() },
    });
  }

  async join(userId: string, dto: JoinTripDto) {
    const trip = await this.prisma.trip.findUnique({
      where: { inviteCode: dto.inviteCode, deletedAt: null },
    });
    if (!trip) throw new NotFoundException('errors.trips.invalidInviteCode');

    const existing = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId: trip.id, userId } },
    });
    if (existing)
      throw new ConflictException('errors.trips.alreadyMember');

    await this.prisma.tripMember.create({
      data: { tripId: trip.id, userId, role: 'MEMBER' },
    });
    return this.findOne(trip.id);
  }

  async leave(tripId: string, userId: string) {
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
    if (!member)
      throw new NotFoundException('errors.auth.notMember');
    if (member.role === 'CREATOR') {
      throw new ForbiddenException('errors.auth.creatorCannotLeave');
    }
    return this.prisma.tripMember.delete({
      where: { tripId_userId: { tripId, userId } },
    });
  }

  async getMembers(tripId: string) {
    return this.prisma.tripMember.findMany({
      where: { tripId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            avatarUrl: true,
            travelScore: true,
            presence: true,
          },
        },
      },
    });
  }

  async removeMember(
    tripId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    await this.ensureCreator(tripId, requesterId);
    if (requesterId === targetUserId) {
      throw new ForbiddenException('errors.trips.creatorCannotLeave');
    }
    return this.prisma.tripMember.delete({
      where: { tripId_userId: { tripId, userId: targetUserId } },
    });
  }

  async regenerateInviteCode(tripId: string, userId: string) {
    await this.ensureCreator(tripId, userId);
    let inviteCode: string;
    do {
      inviteCode = generateInviteCode();
    } while (await this.prisma.trip.findUnique({ where: { inviteCode } }));
    return this.prisma.trip.update({
      where: { id: tripId },
      data: { inviteCode },
    });
  }

  private async ensureCreator(tripId: string, userId: string) {
    const member = await this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
    if (!member) throw new NotFoundException('errors.trips.notFound');
    if (member.role !== 'CREATOR') {
      throw new ForbiddenException('errors.trips.onlyCreator');
    }
  }
}
