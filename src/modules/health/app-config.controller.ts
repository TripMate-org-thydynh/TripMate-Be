import { Controller, Get, Header, Headers } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppPolicyService } from './app-policy.service';

@ApiTags('Health')
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly policy: AppPolicyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Mobile release and maintenance policy' })
  get(@Headers('x-client-channel') channel?: string) {
    return this.policy.get(channel);
  }
}
