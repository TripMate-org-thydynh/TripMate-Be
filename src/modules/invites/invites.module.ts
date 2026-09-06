import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PremiumModule, PrismaModule],
  controllers: [InvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
