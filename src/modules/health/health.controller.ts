// Unauthenticated liveness and readiness endpoints.
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../identity/roles.decorator';
import { ReadinessProbe } from './readiness';

@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(ReadinessProbe) private readonly readiness: ReadinessProbe) {}

  @Get('live')
  live() {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.readiness.check();

    res.status(report.ready ? 200 : 503);

    return { status: report.ready ? 'up' : 'down', checks: report.checks };
  }
}
