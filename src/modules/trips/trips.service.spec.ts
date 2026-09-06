import { Test, TestingModule } from '@nestjs/testing';
import { TripsService } from './trips.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../premium/entitlement.service';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

describe('TripsService', () => {
  let service: TripsService;
  let prisma: any;
  let entitlements: any;

  const mockTrip = {
    id: 'trip-111',
    name: 'Phú Quốc Chill',
    inviteCode: 'ABC123',
    createdBy: 'user-111',
    deletedAt: null,
    members: [{ userId: 'user-111', role: 'CREATOR' }],
  };

  beforeEach(async () => {
    prisma = {
      trip: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      tripMember: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };

    // Mặc định cho qua hạn mức: các test ở đây kiểm hành vi tạo/sửa chuyến,
    // không kiểm paywall. Ca vượt hạn mức được kiểm riêng ở khối cuối file.
    entitlements = {
      assertWithin: jest.fn().mockResolvedValue(undefined),
      assertTripWithin: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementService, useValue: entitlements },
      ],
    }).compile();

    service = module.get<TripsService>(TripsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new trip with a unique invite code and CREATOR role', async () => {
      prisma.trip.findUnique.mockResolvedValue(null);
      prisma.trip.create.mockResolvedValue(mockTrip);

      const result = await service.create('user-111', {
        name: 'Phú Quốc Chill',
        startDate: '2026-08-01',
        endDate: '2026-08-05',
      });

      expect(result).toEqual(mockTrip);
      expect(prisma.trip.create).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if trip does not exist', async () => {
      prisma.trip.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-trip')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return trip details when found', async () => {
      prisma.trip.findUnique.mockResolvedValue(mockTrip);

      const result = await service.findOne('trip-111');
      expect(result).toEqual(mockTrip);
    });
  });

  describe('join', () => {
    it('should throw NotFoundException if invite code is invalid', async () => {
      prisma.trip.findUnique.mockResolvedValue(null);

      await expect(
        service.join('user-222', { inviteCode: 'WRONG1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if user is already a member', async () => {
      prisma.trip.findUnique.mockResolvedValue(mockTrip);
      prisma.tripMember.findUnique.mockResolvedValue({
        tripId: 'trip-111',
        userId: 'user-222',
        role: 'MEMBER',
      });

      await expect(
        service.join('user-222', { inviteCode: 'ABC123' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should add user to trip when valid invite code and not member', async () => {
      prisma.trip.findUnique.mockImplementation(({ where }: any) => {
        if (where.inviteCode) return Promise.resolve(mockTrip);
        if (where.id) return Promise.resolve(mockTrip);
        return Promise.resolve(null);
      });
      prisma.tripMember.findUnique.mockResolvedValue(null);
      prisma.tripMember.create.mockResolvedValue({
        tripId: 'trip-111',
        userId: 'user-222',
        role: 'MEMBER',
      });

      const result = await service.join('user-222', { inviteCode: 'ABC123' });
      expect(result).toEqual(mockTrip);
      expect(prisma.tripMember.create).toHaveBeenCalledWith({
        data: { tripId: 'trip-111', userId: 'user-222', role: 'MEMBER' },
      });
    });
  });

  describe('leave', () => {
    it('should throw ForbiddenException if CREATOR tries to leave', async () => {
      prisma.tripMember.findUnique.mockResolvedValue({
        tripId: 'trip-111',
        userId: 'user-111',
        role: 'CREATOR',
      });

      await expect(service.leave('trip-111', 'user-111')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
