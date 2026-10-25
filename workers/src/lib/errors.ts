/**
 * API エラー。NestJS 版の例外形式 ({ statusCode, error, message }) に合わせる。
 * - 409 STOCK_CONFLICT / INSUFFICIENT_STOCK: 在庫の競合・不足 (再取得して再判断すべき)
 * - 423 STOCKTAKE_IN_PROGRESS: 棚卸し実施中の全面停止
 * - 422: バリデーションは通るが業務ルールに反する (自己承認など)
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** レスポンスボディへ追加で載せる構造化フィールド (プラン上限の内訳など) */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): Record<string, unknown> {
    return { statusCode: this.status, error: this.code, message: this.message, ...(this.extra ?? {}) };
  }
}

export const stockConflict = (message = 'Stock was changed by another user. Reload and retry.'): ApiError =>
  new ApiError(409, 'STOCK_CONFLICT', message);

export const insufficientStock = (message = 'Insufficient stock.'): ApiError =>
  new ApiError(409, 'INSUFFICIENT_STOCK', message);

export const stocktakeLocked = (message = 'Stocktake is in progress. Mutations are suspended.'): ApiError =>
  new ApiError(423, 'STOCKTAKE_IN_PROGRESS', message);

export const notFound = (message = 'Not found.'): ApiError => new ApiError(404, 'NOT_FOUND', message);

export const badRequest = (message: string): ApiError => new ApiError(400, 'BAD_REQUEST', message);

export const forbidden = (message = 'Forbidden.'): ApiError => new ApiError(403, 'FORBIDDEN', message);

export const unauthorized = (message = 'Unauthorized.'): ApiError =>
  new ApiError(401, 'UNAUTHORIZED', message);
