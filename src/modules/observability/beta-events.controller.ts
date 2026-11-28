import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

// Fixed paths let the existing metrics buffer count non-identifying signals
// together with the other request counters. Clients send no event payload.
@Controller('beta-events')
export class BetaEventsController {
  @Post('demo-started')
  @HttpCode(204)
  demoStarted() {}

  @Post('demo-completed')
  @HttpCode(204)
  demoCompleted() {}

  @Post('download-clicked')
  @HttpCode(204)
  downloadClicked() {}

  @UseGuards(JwtAuthGuard)
  @Post('app-opened')
  @HttpCode(204)
  appOpened() {}
}
