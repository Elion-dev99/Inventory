import { Controller, Get, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { AlertsService } from './alerts.service';

@Controller('alerts')
@UseGuards(OidcAuthGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list() {
    return this.alerts.listAlerts();
  }
}
