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
  /** セット品フラグ (0015)。セット品は自前の在庫行を持たない */
  isBundle: z.boolean().optional(),
});

export const createWarehouseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});

export const createLocationSchema = z.object({
  warehouseId: idValue,
  code: z.string().min(1),
  name: z.string().min(1),
  /** 親の保管場所 (階層)。null/未指定 = 倉庫直下 (0015) */
  parentId: idValue.nullable().optional(),
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
  isBundle: z.boolean().optional(),
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
  /** 親の保管場所 (階層)。null で倉庫直下へ戻す (0015) */
  parentId: idValue.nullable().optional(),
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

/* ------------------------------------------------------------------ 0015 商用レベル第1弾 */

/** 返品・廃棄の理由コード (この 2 種別でのみ必須) */
export const reasonCodeSchema = z.enum(['damaged', 'expired', 'defective', 'other']);

/** 返品 (社内から戻り = 在庫+)。入庫と同じ形に理由コードとメモを必須で足したもの */
export const returnMovementSchema = z.object({
  locationId: idValue,
  productId: idValue,
  lotCode: z.string().min(1),
  expiryDate: dateString.optional(),
  quantity: z.number().int().min(1),
  reasonCode: reasonCodeSchema,
  reason: z.string().min(1),
});

/** 廃棄 (在庫-)。通常の消費と同じ在庫検証で、マイナス在庫フローには乗せない */
export const disposalSchema = z.object({
  productId: idValue,
  locationId: idValue.optional(),
  quantity: z.number().int().min(1),
  reasonCode: reasonCodeSchema,
  reason: z.string().min(1),
});

/** 在庫の引当 (商品 + 任意の場所単位) */
export const createReservationSchema = z.object({
  productId: idValue,
  locationId: idValue.nullable().optional(),
  quantity: z.number().int().min(1),
  reason: z.string().min(1),
  /** 期限 (ミリ秒)。過ぎた引当は自動で無効扱い */
  expiresAt: z.number().int().positive().nullable().optional(),
});

/** 引当の消費変換 (場所を指定するとその場所から消費する) */
export const consumeReservationSchema = z.object({
  locationId: idValue.optional(),
});

/** セット品の構成品の置き換え (空配列で構成を全て外す) */
export const bundleComponentsSchema = z.object({
  components: z
    .array(
      z.object({
        productId: idValue,
        quantity: z.number().int().min(1),
      }),
    )
    .max(50),
});

/** セット品の消費 (構成品へ FEFO 展開する) */
export const bundleConsumptionSchema = z.object({
  productId: idValue,
  locationId: idValue.optional(),
  quantity: z.number().int().min(1),
  department: z.string().min(1),
  purpose: z.string().min(1),
});

/** ピッキングリストの作成 */
export const createPickListSchema = z.object({
  type: z.enum(['consume', 'transfer']),
  toLocationId: idValue.nullable().optional(),
  items: z
    .array(
      z.object({
        productId: idValue,
        fromLocationId: idValue,
        plannedQty: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(100),
});

/** ピッキング明細の数量修正 (検品の手入力・計画の調整) */
export const updatePickItemSchema = z.object({
  plannedQty: z.number().int().min(0).optional(),
  pickedQty: z.number().int().min(0).optional(),
});

/** 発注テンプレート (明細は既存の発注書作成と同じ形) */
export const createPoTemplateSchema = z.object({
  name: z.string().min(1),
  supplierId: idValue,
  lines: createPurchaseOrderSchema.shape.lines,
});

/** 定期発注スケジュール (テンプレートに 1 つ) */
export const poScheduleSchema = z.object({
  intervalDays: z.number().int().min(1).max(365),
  enabled: z.boolean(),
});

/** 商品の一括編集 (指定したフィールドだけを一括で書き換える) */
export const bulkProductsSchema = z.object({
  ids: z.array(idValue).min(1).max(200),
  patch: z.object({
    safetyStock: z.number().int().min(0).optional(),
    unitCost: z.number().int().min(0).nullable().optional(),
    caseSize: z.number().int().min(1).nullable().optional(),
    leadTimeDays: z.number().int().min(0).nullable().optional(),
    /** true = 有効化 (論理削除を解除)、false = 無効化 (論理削除) */
    active: z.boolean().optional(),
  }),
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
