import { z } from 'zod';

/**
 * リクエスト検証 (zod)。NestJS 版の DTO (class-validator) に対応する。
 * ID は Nest 版が文字列で受けるのに合わせ、数値文字列も受理して number に寄せる。
 */

export const idValue = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform((v) => (typeof v === 'string' ? Number(v) : v));

export const createProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
  barcode: z.string().optional(),
  safetyStock: z.number().int().min(0).optional(),
  requiresExpiry: z.boolean().optional(),
  expiryAlertDays: z.number().int().min(0).optional(),
});

export const createWarehouseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});

export const createLocationSchema = z.object({
  warehouseId: idValue,
  code: z.string().min(1),
  name: z.string().min(1),
});

/** YYYY-MM-DD */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const createLotSchema = z.object({
  productId: idValue,
  lotCode: z.string().min(1),
  expiryDate: dateString.optional(),
});

export const inboundSchema = z.object({
  locationId: idValue,
  productId: idValue,
  lotCode: z.string().min(1),
  /** YYYY-MM-DD。期限管理対象の商品では必須 (Coordinator で検証) */
  expiryDate: dateString.optional(),
  quantity: z.number().int().min(1),
});

export const consumptionSchema = z.object({
  productId: idValue,
  locationId: idValue.optional(),
  quantity: z.number().int().min(1),
  /** 社内消費の用途 (部署・目的) は必須 */
  department: z.string().min(1),
  purpose: z.string().min(1),
  /** FEFO 提案から逸脱する場合の理由 */
  fefoDeviationReason: z.string().optional(),
  /** マイナス在庫の例外消費に使う承認済みレコードの ID */
  negativeApprovalId: idValue.optional(),
});

export const createApprovalSchema = z.object({
  stockId: idValue,
  quantity: z.number().int().min(1),
  reason: z.string().min(1),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

/** 'YYYY-MM-DD' -> UTC 0時のミリ秒。不正な日付は null */
export function parseDateOnly(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return ms;
}

/** ミリ秒 -> 'YYYY-MM-DD' (UTC) */
export function formatDateOnly(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}
