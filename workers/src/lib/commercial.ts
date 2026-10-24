import { badRequest, notFound } from './errors';
import {
  assemblableCount,
  freeTotalsByProduct,
  type ActiveReservationInput,
  type FreeStockRowInput,
} from './free-stock';

/**
 * 商用レベル第1弾 (0015) の共有ロジック:
 * 引当とフリー在庫、セット品の組立可能数、発注書の下書き生成
 * (手動・テンプレート・定期の 3 経路で共用) と定期下書きの実行。
 * テーブル・列が無い環境 (0015 未適用) では、呼び出し側が hasTable /
 * hasColumn で確認してから使う前提。ここでは素直に例外を伝播させる。
 */

async function hasColumnDb(db: D1Database, table: string, column: string): Promise<boolean> {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return results.some((r) => r.name === column);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 引当 / フリー在庫

export interface ReservationDbRow {
  id: number;
  store_id: number;
  product_id: number;
  location_id: number | null;
  quantity: number;
  reason: string;
  status: string;
  expires_at: number | null;
  created_by: number;
  created_at: number;
  updated_at: number;
}

/** 有効な引当 (status='active' かつ期限内) を返す。期限切れはここで自動的に除外する */
export async function activeReservationRows(
  db: D1Database,
  storeId: number,
  nowMs: number,
): Promise<ReservationDbRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reservations
        WHERE store_id = ?1 AND status = 'active' AND (expires_at IS NULL OR expires_at > ?2)
        ORDER BY id ASC`,
    )
    .bind(storeId, nowMs)
    .all<ReservationDbRow>();
  return results;
}

export function reservationJson(r: ReservationDbRow): Record<string, unknown> {
  return {
    id: r.id,
    productId: r.product_id,
    locationId: r.location_id,
    quantity: r.quantity,
    reason: r.reason,
    status: r.status,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 店舗の在庫行 (フリー在庫計算の入力形)。productIds を渡すとその商品だけに絞る */
export async function storeStockRows(
  db: D1Database,
  storeId: number,
  productIds?: readonly number[],
): Promise<FreeStockRowInput[]> {
  let sql = `SELECT s.id AS stockId, l.product_id AS productId, s.location_id AS locationId, s.quantity
               FROM stocks s JOIN lots l ON l.id = s.lot_id
              WHERE s.store_id = ?`;
  const params: number[] = [storeId];
  if (productIds !== undefined) {
    if (productIds.length === 0) return [];
    sql += ` AND l.product_id IN (${productIds.map(() => '?').join(',')})`;
    params.push(...productIds);
  }
  sql += ' ORDER BY s.id ASC';
  const { results } = await db.prepare(sql).bind(...params).all<FreeStockRowInput>();
  return results;
}

/** 店舗全体のフリー在庫合計 (productId -> 合計) */
export async function storeFreeTotals(
  db: D1Database,
  storeId: number,
  nowMs: number,
): Promise<Map<number, number>> {
  const [stocks, reservations] = await Promise.all([
    storeStockRows(db, storeId),
    activeReservationRows(db, storeId, nowMs),
  ]);
  const active: ActiveReservationInput[] = reservations.map((r) => ({
    productId: r.product_id,
    locationId: r.location_id,
    quantity: r.quantity,
  }));
  return freeTotalsByProduct(stocks, active);
}

// ---------------------------------------------------------------- セット品

export interface BundleComponentRow {
  component_product_id: number;
  quantity: number;
}

export async function bundleComponentRows(
  db: D1Database,
  bundleProductId: number,
): Promise<BundleComponentRow[]> {
  const { results } = await db
    .prepare(
      'SELECT component_product_id, quantity FROM product_bundles WHERE bundle_product_id = ?1 ORDER BY component_product_id ASC',
    )
    .bind(bundleProductId)
    .all<BundleComponentRow>();
  return results;
}

export interface BundleAvailability {
  productId: number;
  assemblable: number;
  /** 構成品単価の合算 (セット品の評価単価) */
  unitCost: number;
  components: { productId: number; quantity: number; freeStock: number; unitCost: number | null }[];
}

/** セット品 1 件の組立可能数と構成品内訳。フリー在庫は店舗全体の合計で判定する */
export async function bundleAvailability(
  db: D1Database,
  storeId: number,
  bundleProductId: number,
  freeTotals?: Map<number, number>,
): Promise<BundleAvailability> {
  const components = await bundleComponentRows(db, bundleProductId);
  const totals = freeTotals ?? (await storeFreeTotals(db, storeId, Date.now()));
  const detail: BundleAvailability['components'] = [];
  let unitCost = 0;
  for (const comp of components) {
    const row = await db
      .prepare('SELECT unit_cost FROM products WHERE id = ?1 AND store_id = ?2')
      .bind(comp.component_product_id, storeId)
      .first<{ unit_cost: number | null }>();
    const cost = row?.unit_cost ?? null;
    if (cost !== null) unitCost += cost * comp.quantity;
    detail.push({
      productId: comp.component_product_id,
      quantity: comp.quantity,
      freeStock: totals.get(comp.component_product_id) ?? 0,
      unitCost: cost,
    });
  }
  return {
    productId: bundleProductId,
    assemblable: assemblableCount(detail.map((d) => ({ quantity: d.quantity, freeStock: d.freeStock }))),
    unitCost,
    components: detail,
  };
}

// ---------------------------------------------------------------- 発注書の下書き生成

export interface PurchaseOrderLineInput {
  productId: number;
  quantity?: number;
  inputQuantity?: number;
  inputUnit?: 'base' | 'case';
  unitCost?: number;
}

/**
 * 発注書 (下書き) を 1 件作成する。手動作成・テンプレート生成・定期生成の
 * 3 経路で共用し、明細の単位換算 (ケース → 基本単位) もここで解決する。
 * 冪等キーと監査ログは経路ごとに異なるため呼び出し側の責務とする。
 */
export async function createDraftPurchaseOrder(
  db: D1Database,
  args: {
    storeId: number;
    supplierId: number;
    expectedDate?: string | null;
    note?: string | null;
    actorId: number;
    source: 'manual' | 'template' | 'schedule';
    lines: readonly PurchaseOrderLineInput[];
    nowMs: number;
  },
): Promise<number> {
  const supplier = await db
    .prepare('SELECT id FROM suppliers WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(args.supplierId, args.storeId)
    .first<{ id: number }>();
  if (!supplier) throw notFound('Supplier not found');

  const withCase = await hasColumnDb(db, 'products', 'case_size');
  const withInputCols = await hasColumnDb(db, 'purchase_order_lines', 'input_quantity');
  const withSource = await hasColumnDb(db, 'purchase_orders', 'source');

  interface ResolvedLine {
    productId: number;
    quantity: number;
    inputQuantity: number;
    inputUnit: 'base' | 'case';
    unitCost: number | null;
  }
  const resolvedLines: ResolvedLine[] = [];
  for (const line of args.lines) {
    const product = await db
      .prepare(
        `SELECT id${withCase ? ', case_size' : ''} FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(line.productId, args.storeId)
      .first<{ id: number; case_size?: number | null }>();
    if (!product) throw notFound(`Product not found: ${line.productId}`);
    if (line.inputUnit === 'case') {
      if (line.inputQuantity === undefined) {
        throw badRequest('inputQuantity is required when inputUnit is case');
      }
      const caseSize = product.case_size ?? null;
      if (caseSize === null || caseSize < 1) {
        throw badRequest(`Product ${line.productId} has no case size (case_size)`);
      }
      resolvedLines.push({
        productId: line.productId,
        quantity: line.inputQuantity * caseSize,
        inputQuantity: line.inputQuantity,
        inputUnit: 'case',
        unitCost: line.unitCost ?? null,
      });
    } else {
      const qty = line.inputQuantity ?? line.quantity;
      if (qty === undefined) throw badRequest('quantity is required for each purchase order line');
      resolvedLines.push({
        productId: line.productId,
        quantity: qty,
        inputQuantity: qty,
        inputUnit: 'base',
        unitCost: line.unitCost ?? null,
      });
    }
  }

  const poRes = await db
    .prepare(
      withSource
        ? `INSERT INTO purchase_orders (supplier_id, status, expected_date, note, created_by, store_id, source, created_at, updated_at)
           VALUES (?1, 'draft', ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
        : `INSERT INTO purchase_orders (supplier_id, status, expected_date, note, created_by, store_id, created_at, updated_at)
           VALUES (?1, 'draft', ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
    .bind(
      ...(withSource
        ? [args.supplierId, args.expectedDate ?? null, args.note ?? null, args.actorId, args.storeId, args.source, args.nowMs]
        : [args.supplierId, args.expectedDate ?? null, args.note ?? null, args.actorId, args.storeId, args.nowMs]),
    )
    .run();
  const poId = Number(poRes.meta.last_row_id);
  const stmts = resolvedLines.map((line) =>
    withInputCols
      ? db
          .prepare(
            `INSERT INTO purchase_order_lines (po_id, product_id, quantity, received_quantity, unit_cost, input_quantity, input_unit)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)`,
          )
          .bind(poId, line.productId, line.quantity, line.unitCost, line.inputQuantity, line.inputUnit)
      : db
          .prepare(
            `INSERT INTO purchase_order_lines (po_id, product_id, quantity, received_quantity, unit_cost)
             VALUES (?1, ?2, ?3, 0, ?4)`,
          )
          .bind(poId, line.productId, line.quantity, line.unitCost),
  );
  if (stmts.length > 0) await db.batch(stmts);
  return poId;
}

// ---------------------------------------------------------------- 定期発注 (下書き生成)

interface DueScheduleRow {
  schedule_id: number;
  template_id: number;
  interval_days: number;
  next_run_at: number;
  store_id: number;
  supplier_id: number;
  lines: string;
  created_by: number;
}

/**
 * 期限を過ぎた有効スケジュールを下書き PO 化し、next_run_at を前進させる。
 * 自動発注はしない (必ず下書き止まり)。1 件の失敗で他を止めない。
 * scheduled ハンドラ (15 分 Cron) から呼ばれる。戻り値は生成した下書き数。
 */
export async function runScheduledPoDrafts(db: D1Database, nowMs: number): Promise<number> {
  let due: DueScheduleRow[] = [];
  try {
    const { results } = await db
      .prepare(
        `SELECT s.id AS schedule_id, s.template_id, s.interval_days, s.next_run_at,
                t.store_id, t.supplier_id, t.lines, t.created_by
           FROM po_schedules s
           JOIN po_templates t ON t.id = s.template_id
          WHERE s.enabled = 1 AND s.next_run_at <= ?1
          ORDER BY s.next_run_at ASC LIMIT 50`,
      )
      .bind(nowMs)
      .all<DueScheduleRow>();
    due = results;
  } catch {
    // 0015 未適用の環境では定期発注そのものが無い
    return 0;
  }
  let generated = 0;
  const DAY = 86_400_000;
  for (const row of due) {
    try {
      const lines = JSON.parse(row.lines) as PurchaseOrderLineInput[];
      if (!Array.isArray(lines) || lines.length === 0) continue;
      await createDraftPurchaseOrder(db, {
        storeId: row.store_id,
        supplierId: row.supplier_id,
        actorId: row.created_by,
        source: 'schedule',
        lines,
        nowMs,
      });
      generated += 1;
      await db
        .prepare(
          `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
           VALUES (?1, 'purchase_order.create_scheduled', 'po_template', ?2, ?3, ?4, ?5)`,
        )
        .bind(row.created_by, String(row.template_id), JSON.stringify({ scheduleId: row.schedule_id }), row.store_id, nowMs)
        .run();
    } catch (e) {
      console.error('runScheduledPoDrafts: template', row.template_id, 'failed', e);
    }
    // 成功・失敗にかかわらず次回を前進させ、失敗の無限リトライを避ける
    let next = row.next_run_at;
    const step = Math.max(1, row.interval_days) * DAY;
    while (next <= nowMs) next += step;
    await db
      .prepare('UPDATE po_schedules SET next_run_at = ?1, last_run_at = ?2 WHERE id = ?3')
      .bind(next, nowMs, row.schedule_id)
      .run();
  }
  return generated;
}
