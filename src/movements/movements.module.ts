import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StocktakeGuard } from '../common/guards/stocktake.guard';
import { StocktakesModule } from '../stocktakes/stocktakes.module';
import { MovementsController } from './movements.controller';
import { MovementsService } from './movements.service';

@Module({
  imports: [AuthModule, StocktakesModule],
  controllers: [MovementsController],
  providers: [MovementsService, StocktakeGuard],
})
export class MovementsModule {}
