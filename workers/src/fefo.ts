/**
 * FEFO (First Expired, First Out) 提案ロジック — 純粋関数。
 * NestJS 版 src/inventory/fefo.ts の移植。違いは ID が number、
 * 日時は Unix ミリ秒 (number) で扱うことだけ。ルールは同一:
 * - 期限切れロットは対象外 (原則消費ブロック)。期限当日はまだ消費可能
 * - 期限なしロットは期限ありロットの後
 * - 同期限では入庫が古い順 (receivedAt)、最後に stockId 昇順で決定的に並べる
 */

export interface FefoCandidate {
  stockId: number;
  lotId: number;
  /** 有効期限 (UTC 0時のミリ秒)。null = 期限管理対象外 */
  expiryDate: number | null;
  /** 現在の残高 */
  quantity: number;
  /** 初回入庫日時 (ミリ秒。タイブレーカー) */
  receivedAt: number;
}

export interface FefoAllocation {
  stockId: number;
  lotId: number;
  quantity: number;
}

export interface FefoProposal {
  allocations: FefoAllocation[];
  /** 割り当てきれなかった数量 (>0 なら在庫不足) */
  shortfall: number;
}

const DAY_MS = 86_400_000;

/** 日付部分 (UTC) のみに切り捨てる */
export function dateOnlyUtcMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function isExpired(expiryDate: number | null, nowMs: number): boolean {
  if (expiryDate === null) return false;
  return dateOnlyUtcMs(expiryDate) < dateOnlyUtcMs(nowMs);
}

export function compareFefo(a: FefoCandidate, b: FefoCandidate): number {
  if (a.expiryDate === null && b.expiryDate !== null) return 1;
  if (a.expiryDate !== null && b.expiryDate === null) return -1;
  if (a.expiryDate !== null && b.expiryDate !== null) {
    const diff = dateOnlyUtcMs(a.expiryDate) - dateOnlyUtcMs(b.expiryDate);
    if (diff !== 0) return diff;
  }
  const receivedDiff = a.receivedAt - b.receivedAt;
  if (receivedDiff !== 0) return receivedDiff;
  return a.stockId - b.stockId;
}

export function proposeFefoAllocation(
  candidates: readonly FefoCandidate[],
  requestedQuantity: number,
  nowMs: number = Date.now(),
): FefoProposal {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error('requestedQuantity must be a positive integer');
  }
  const eligible = candidates
    .filter((c) => c.quantity > 0 && !isExpired(c.expiryDate, nowMs))
    .sort(compareFefo);

  const allocations: FefoAllocation[] = [];
  let remaining = requestedQuantity;
  for (const candidate of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(candidate.quantity, remaining);
    allocations.push({ stockId: candidate.stockId, lotId: candidate.lotId, quantity: take });
    remaining -= take;
  }
  return { allocations, shortfall: remaining };
}
