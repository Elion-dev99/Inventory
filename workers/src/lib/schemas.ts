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
  /** 単価 (円)。在庫評価額の算出に使う */
  unitCost: z.number().int().min(0).optional(),
  /** 入数: 1 ケースあたりの基本単位数量 (0014)。null = ケース単位なし */
  caseSize: z.number().int().min(1).nullable().optional(),
  /** リードタイム (日)。発注点の計算に使う (0014) */
  leadTimeDays: z.number().int().min(0).nullable().optional(),
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

export const transferSchema = z.object({
  fromLocationId: idValue,
  toLocationId: idValue,
  productId: idValue,
  /** 指定時はそのロットのみから移動する。未指定は FEFO 順 */
  lotId: idValue.optional(),
  quantity: z.number().int().min(1),
});

/** 商品の編集 (SKU は識別子のため変更不可。バーコードは null で解除可) */
export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  barcode: z.string().nullable().optional(),
  safetyStock: z.number().int().min(0).optional(),
  requiresExpiry: z.boolean().optional(),
  expiryAlertDays: z.number().int().min(0).nullable().optional(),
  unitCost: z.number().int().min(0).nullable().optional(),
  caseSize: z.number().int().min(1).nullable().optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
});

/** 仕入先マスタ */
export const createSupplierSchema = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  note: z.string().optional(),
  /** 既定リードタイム (日)。商品個別の指定が無い発注点計算で使う (0014) */
  leadTimeDays: z.number().int().min(0).nullable().optional(),
});

export const updateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  contact: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
});

/** 発注書の作成 (作成時は下書き draft。発注確定は status を ordered へ進める運用) */
export const createPurchaseOrderSchema = z.object({
  supplierId: idValue,
  expectedDate: dateString.optional(),
  note: z.string().optional(),
  lines: z
    .array(
      z.object({
        productId: idValue,
        /** 基本単位での発注数量。inputUnit が 'case' のときは省略可 (サーバーで換算する) */
        quantity: z.number().int().min(1).optional(),
        /** 入力時の数量と単位 (0014)。inputUnit: 'case' は inputQuantity × 商品の入数 */
        inputQuantity: z.number().int().min(1).optional(),
        inputUnit: z.enum(['base', 'case']).optional(),
        unitCost: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
});

/** 発注書の入荷登録 (行ごとに入荷数とロットを指定する) */
export const receivePurchaseOrderSchema = z.object({
  locationId: idValue,
  lines: z
    .array(
      z.object({
        lineId: idValue,
        quantity: z.number().int().min(1),
        lotCode: z.string().min(1),
        expiryDate: dateString.optional(),
      }),
    )
    .min(1),
});

export const updateWarehouseSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export const updateLocationSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

/** ロットの編集は lot_code と expiry_date のみ (expiryDate: null で期限を外す) */
export const updateLotSchema = z.object({
  lotCode: z.string().min(1).optional(),
  expiryDate: dateString.nullable().optional(),
});

/** 棚卸し lines への実数入力 */
export const countedQuantitySchema = z.object({
  countedQuantity: z.number().int().min(0),
});

/** 棚卸しの開始 (0014: 部分棚卸しと盲検)。ボディなしは全件・非盲検として扱う */
export const createStocktakeSchema = z.object({
  scopeType: z.enum(['full', 'locations']).optional(),
  locationIds: z.array(idValue).optional(),
  blind: z.boolean().optional(),
});

/** 棚卸しの差異承認/差し戻し */
export const decideStocktakeSchema = z.object({
  approve: z.boolean(),
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
