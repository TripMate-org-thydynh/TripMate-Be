import { Module } from '@nestjs/common';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PremiumModule } from '../premium/premium.module';

@Module({
  imports: [PrismaModule, PremiumModule],
  controllers: [InvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
