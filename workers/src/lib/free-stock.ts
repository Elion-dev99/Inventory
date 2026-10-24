/**
 * フリー在庫の計算 (純粋関数)。
 * フリー在庫 = 実在庫 - 有効引当。引当は商品単位で、場所指定があるものは
 * その場所の在庫から、指定が無いものは店舗全体の在庫から差し引く。
 * 複数の在庫行 (ロット) への配分は stock id 昇順のウォーターフォールで決める:
 * 先の行から順に引当を負担し、行のフリーは 0 未満にしない。ただし引当総量が
 * 実在庫総量を超える (期限切れ解放の遅延など) 場合は、合計が一致するよう
 * 最後の行に残りを寄せて負値になりうる。
 */

export interface FreeStockRowInput {
  stockId: number;
  productId: number;
  locationId: number;
  quantity: number;
}

export interface ActiveReservationInput {
  productId: number;
  /** null = 店舗全体への引当 */
  locationId: number | null;
  quantity: number;
}

/** stockId -> フリー数量 */
export function computeFreeQuantities(
  stocks: readonly FreeStockRowInput[],
  reservations: readonly ActiveReservationInput[],
): Map<number, number> {
  const free = new Map<number, number>();
  const rowsByProduct = new Map<number, FreeStockRowInput[]>();
  for (const s of stocks) {
    free.set(s.stockId, s.quantity);
    const rows = rowsByProduct.get(s.productId);
    if (rows) rows.push(s);
    else rowsByProduct.set(s.productId, [s]);
  }
  for (const rows of rowsByProduct.values()) {
    rows.sort((a, b) => a.stockId - b.stockId);
  }

  const subtract = (rows: readonly FreeStockRowInput[], amount: number): void => {
    let remaining = amount;
    for (const row of rows) {
      if (remaining <= 0) break;
      const current = free.get(row.stockId) ?? 0;
      const take = Math.min(Math.max(current, 0), remaining);
      free.set(row.stockId, current - take);
      remaining -= take;
    }
    if (remaining > 0 && rows.length > 0) {
      // 引当が実在庫を超える場合のみ: 合計を一致させるため最後の行へ寄せる
      const last = rows[rows.length - 1] as FreeStockRowInput;
      free.set(last.stockId, (free.get(last.stockId) ?? 0) - remaining);
    }
  };

  // 場所指定の引当を先に、その場所の行だけから差し引く
  const byLocation = new Map<string, number>();
  const storeWide = new Map<number, number>();
  for (const r of reservations) {
    if (r.locationId === null) {
      storeWide.set(r.productId, (storeWide.get(r.productId) ?? 0) + r.quantity);
    } else {
      const key = `${r.productId}:${r.locationId}`;
      byLocation.set(key, (byLocation.get(key) ?? 0) + r.quantity);
    }
  }
  for (const [key, amount] of byLocation) {
    const [productId, locationId] = key.split(':').map(Number) as [number, number];
    const rows = (rowsByProduct.get(productId) ?? []).filter((r) => r.locationId === locationId);
    subtract(rows, amount);
  }
  for (const [productId, amount] of storeWide) {
    subtract(rowsByProduct.get(productId) ?? [], amount);
  }
  return free;
}

/** productId -> フリー在庫の合計 */
export function freeTotalsByProduct(
  stocks: readonly FreeStockRowInput[],
  reservations: readonly ActiveReservationInput[],
): Map<number, number> {
  const free = computeFreeQuantities(stocks, reservations);
  const totals = new Map<number, number>();
  for (const s of stocks) {
    totals.set(s.productId, (totals.get(s.productId) ?? 0) + (free.get(s.stockId) ?? 0));
  }
  return totals;
}

/** 指定場所における商品のフリー在庫 (引当作成時の検証用) */
export function freeAtLocation(
  stocks: readonly FreeStockRowInput[],
  reservations: readonly ActiveReservationInput[],
  productId: number,
  locationId: number,
): number {
  const free = computeFreeQuantities(stocks, reservations);
  let total = 0;
  for (const s of stocks) {
    if (s.productId === productId && s.locationId === locationId) {
      total += free.get(s.stockId) ?? 0;
    }
  }
  return total;
}

/**
 * セット品の組立可能数 = min(構成品のフリー在庫 / 必要数) の切り捨て。
 * 構成品が無いセットは 0。
 */
export function assemblableCount(
  components: readonly { quantity: number; freeStock: number }[],
): number {
  if (components.length === 0) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (const c of components) {
    if (c.quantity < 1) return 0;
    min = Math.min(min, Math.floor(c.freeStock / c.quantity));
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0;
}
