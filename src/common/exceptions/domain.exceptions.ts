import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/** 在庫不足・楽観的ロック競合など、再取得して再判断すべき競合 (409) */
export class StockConflictException extends ConflictException {
  constructor(message = 'Stock was changed by another user. Reload and retry.') {
    super({ statusCode: HttpStatus.CONFLICT, error: 'STOCK_CONFLICT', message });
  }
}

/** 利用可能数を下回る消費 (在庫不足) */
export class InsufficientStockException extends ConflictException {
  constructor(message = 'Insufficient stock.') {
    super({ statusCode: HttpStatus.CONFLICT, error: 'INSUFFICIENT_STOCK', message });
  }
}

/** 棚卸し実施中は更新系 API を全面停止する (423 Locked) */
export class StocktakeLockedException extends HttpException {
  constructor(message = 'Stocktake is in progress. Mutations are suspended.') {
    // @nestjs/common の HttpStatus には 423 が無いため数値リテラルを使う
    super({ statusCode: 423, error: 'STOCKTAKE_IN_PROGRESS', message }, 423);
  }
}
