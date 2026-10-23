import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { STOCKTAKE_LOCK_CHECKER } from '../common/guards/stocktake.guard';
import { StocktakesController } from './stocktakes.controller';
import { StocktakesService } from './stocktakes.service';

@Module({
  imports: [AuthModule],
  controllers: [StocktakesController],
  providers: [
    StocktakesService,
    { provide: STOCKTAKE_LOCK_CHECKER, useExisting: StocktakesService },
  ],
  exports: [StocktakesService, STOCKTAKE_LOCK_CHECKER],
})
export class StocktakesModule {}
