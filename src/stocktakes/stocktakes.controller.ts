import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { StocktakesService } from './stocktakes.service';

@Controller('stocktakes')
@UseGuards(OidcAuthGuard)
export class StocktakesController {
  constructor(private readonly stocktakes: StocktakesService) {}

  @Post()
  start(@CurrentUser() user: AuthenticatedUser) {
    return this.stocktakes.start(BigInt(user.userId));
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.stocktakes.confirm(BigInt(id), BigInt(user.userId));
  }
}
