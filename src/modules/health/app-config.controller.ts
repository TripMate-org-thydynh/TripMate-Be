import { Controller, Get, Header, Headers } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppPolicyService } from './app-policy.service';
import { CapabilitiesService } from './capabilities.service';

@ApiTags('Health')
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly policy: AppPolicyService, private readonly capabilities: CapabilitiesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Mobile release and maintenance policy' })
  async get(@Headers('x-client-channel') channel?: string) {
    const [policy, capabilities] = await Promise.all([this.policy.get(channel), this.capabilities.getAll()]);
    return { ...policy, capabilities };
  }
}
