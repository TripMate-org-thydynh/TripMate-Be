import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CapabilitiesService, Capability } from './capabilities.service';

const CAPABILITY_KEY = Symbol('capability');
type Rule = { key: Capability; write: boolean };
export const RequireCapability = (key: Capability, write = true) => SetMetadata(CAPABILITY_KEY, { key, write });

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly capabilities: CapabilitiesService) {}

  async canActivate(context: ExecutionContext) {
    const rule = this.reflector.getAllAndOverride<Rule>(CAPABILITY_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!rule) return true;
    const policy = await this.capabilities.get(rule.key);
    const details = { capability: rule.key, message: policy.message || 'errors.capability.unavailable' };
    if (policy.mode === 'hidden') throw new NotFoundException({ ...details, code: 'CAPABILITY_HIDDEN' });
    if (policy.mode === 'maintenance') throw new ServiceUnavailableException({ ...details, code: 'CAPABILITY_MAINTENANCE' });
    if (policy.mode === 'readOnly' && rule.write) throw new ForbiddenException({ ...details, code: 'CAPABILITY_READ_ONLY' });
    return true;
  }
}
