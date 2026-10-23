import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { StocktakeLockedException } from '../exceptions/domain.exceptions';

export const STOCKTAKE_LOCK_CHECKER = Symbol('STOCKTAKE_LOCK_CHECKER');

export interface StocktakeLockChecker {
  isLocked(): Promise<boolean>;
}

/**
 * 棚卸し全面停止ガード (基本設計 4章/5章)。
 * 照会系 (GET/HEAD/OPTIONS) は通し、更新系は棚卸し実施中なら 423 を返す。
 * 判定本体は StocktakesService が持ち、循環依存を避けるためトークン経由で注入する。
 */
@Injectable()
export class StocktakeGuard implements CanActivate {
  constructor(
    @Inject(STOCKTAKE_LOCK_CHECKER) private readonly checker: StocktakeLockChecker,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{ method: string }>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (await this.checker.isLocked()) {
      throw new StocktakeLockedException();
    }
    return true;
  }
}
