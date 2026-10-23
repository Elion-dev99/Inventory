import { proposeFefoAllocation, isExpired, type FefoCandidate } from './fefo';

/**
 * 消費の配分計算 — Coordinator の中核ロジック (純粋関数)。
 * D1 から読んだ候補行 + 要求数量 + (任意の) マイナス在庫承認から、
 * 「どの stocks 行をどう更新するか」の計画を作る。DB は触らない。
 */

export interface CandidateRow extends FefoCandidate {
  /** 楽観的ロック用バージョン (読み取り時点) */
  version: number;
  locationId: number;
  warehouseId: number;
}

export interface NegativeApprovalInfo {
  id: number;
  stockId: number;
  /** マイナスを許容する数量 */
  quantity: number;
}

export interface PlannedAllocation {
  stockId: number;
  lotId: number;
  locationId: number;
  /** この配分で減らす数量 */
  quantity: number;
  /** 更新前の残高 */
  before: number;
  /** 更新後の残高 (マイナス配分では負になりうる) */
  after: number;
  /** 読み取り時点の version。条件付き UPDATE の期待値 */
  version: number;
  /** マイナス在庫承認によって許可された配分か */
  negative: boolean;
}

export interface ConsumptionPlan {
  allocations: PlannedAllocation[];
  /** 承認を使ってもなお不足する数量 (0 なら実行可能) */
  shortfall: number;
  /** 消費した承認の ID (使った場合のみ) */
  usedApprovalId: number | null;
}

export function planConsumption(
  candidates: readonly CandidateRow[],
  requestedQuantity: number,
  nowMs: number,
  approval: NegativeApprovalInfo | null = null,
): ConsumptionPlan {
  const byId = new Map(candidates.map((c) => [c.stockId, c]));
  const proposal = proposeFefoAllocation(candidates, requestedQuantity, nowMs);

  const allocations: PlannedAllocation[] = proposal.allocations.map((a) => {
    const row = byId.get(a.stockId);
    if (!row) throw new Error(`candidate missing for stock ${a.stockId}`);
    return {
      stockId: a.stockId,
      lotId: a.lotId,
      locationId: row.locationId,
      quantity: a.quantity,
      before: row.quantity,
      after: row.quantity - a.quantity,
      version: row.version,
      negative: false,
    };
  });

  let shortfall = proposal.shortfall;
  let usedApprovalId: number | null = null;

  if (shortfall > 0 && approval !== null && shortfall <= approval.quantity) {
    const target = byId.get(approval.stockId);
    // 承認対象の在庫が同じ消費の候補に含まれ、期限切れロットでない場合のみ使える。
    // (期限切れ品の消費はマイナス承認があっても許可しない)
    if (target && !isExpired(target.expiryDate, nowMs)) {
      const existing = allocations.find((a) => a.stockId === target.stockId);
      if (existing) {
        existing.quantity += shortfall;
        existing.after -= shortfall;
        existing.negative = true;
      } else {
        allocations.push({
          stockId: target.stockId,
          lotId: target.lotId,
          locationId: target.locationId,
          quantity: shortfall,
          before: target.quantity,
          after: target.quantity - shortfall,
          version: target.version,
          negative: true,
        });
      }
      usedApprovalId = approval.id;
      shortfall = 0;
    }
  }

  return { allocations, shortfall, usedApprovalId };
}
