/**
 * FEFO (First Expired, First Out) 提案ロジック — 純粋関数。
 * 要件 Q4 / 基本設計 5章: 消費は有効期限が近いロットから使うことを基本とする。
 * - 期限切れロットは対象外 (原則消費ブロック)
 * - 期限なしロットは期限ありロットの後
 * - 同期限では入庫が古い順 (receivedAt)、最後に stockId 昇順で決定的に並べる
 */

export interface FefoCandidate {
  stockId: bigint;
  lotId: bigint;
  /** 有効期限 (日付)。null = 期限管理対象外 */
  expiryDate: Date | null;
  /** 現在の残高 */
  quantity: number;
  /** 初回入庫日時 (タイブレーカー) */
  receivedAt: Date;
}

export interface FefoAllocation {
  stockId: bigint;
  lotId: bigint;
  quantity: number;
}

export interface FefoProposal {
  allocations: FefoAllocation[];
  /** 割り当てきれなかった数量 (>0 なら在庫不足) */
  shortfall: number;
}

/** 日付部分 (UTC) のみで比較する: 期限当日はまだ消費可能 */
function dateOnlyUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function isExpired(expiryDate: Date | null, now: Date): boolean {
  if (expiryDate === null) return false;
  return dateOnlyUtc(expiryDate) < dateOnlyUtc(now);
}

export function compareFefo(a: FefoCandidate, b: FefoCandidate): number {
  if (a.expiryDate === null && b.expiryDate !== null) return 1;
  if (a.expiryDate !== null && b.expiryDate === null) return -1;
  if (a.expiryDate !== null && b.expiryDate !== null) {
    const diff = dateOnlyUtc(a.expiryDate) - dateOnlyUtc(b.expiryDate);
    if (diff !== 0) return diff;
  }
  const receivedDiff = a.receivedAt.getTime() - b.receivedAt.getTime();
  if (receivedDiff !== 0) return receivedDiff;
  return a.stockId < b.stockId ? -1 : a.stockId > b.stockId ? 1 : 0;
}

export function proposeFefoAllocation(
  candidates: readonly FefoCandidate[],
  requestedQuantity: number,
  now: Date = new Date(),
): FefoProposal {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error('requestedQuantity must be a positive integer');
  }
  const eligible = candidates
    .filter((c) => c.quantity > 0 && !isExpired(c.expiryDate, now))
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
