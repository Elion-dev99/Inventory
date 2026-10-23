import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { StocktakeGuard } from '../common/guards/stocktake.guard';
import { MovementsService } from './movements.service';
import { ConsumeDto, InboundDto, TransferDto } from './dto/movements.dto';

/**
 * 更新系エンドポイント: 認証ガード + 棚卸し全面停止ガード (423) を通す。
 * Idempotency-Key の検証は IdempotencyInterceptor を各ルートに適用する想定 (雛形では未適用)。
 */
@Controller()
@UseGuards(OidcAuthGuard, StocktakeGuard)
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Post('inbound')
  inbound(@Body() dto: InboundDto, @CurrentUser() user: AuthenticatedUser) {
    return this.movements.inbound(dto, BigInt(user.userId));
  }

  @Post('consumptions')
  consume(@Body() dto: ConsumeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.movements.consume(dto, BigInt(user.userId));
  }

  @Post('transfers')
  transfer(@Body() dto: TransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.movements.transfer(dto, BigInt(user.userId));
  }
}
