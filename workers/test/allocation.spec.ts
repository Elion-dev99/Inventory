import { describe, expect, it } from 'vitest';
import { planConsumption, type CandidateRow } from '../src/allocation';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function row(partial: Partial<CandidateRow> & { stockId: number }): CandidateRow {
  return {
    lotId: partial.stockId,
    expiryDate: null,
    quantity: 10,
    receivedAt: NOW - 30 * DAY,
    version: 1,
    locationId: 1,
    warehouseId: 1,
    ...partial,
  };
}

describe('planConsumption', () => {
  it('FEFO 配分に before/after/version を付け、不足なしで計画する', () => {
    const plan = planConsumption(
      [
        row({ stockId: 1, quantity: 4, version: 3, expiryDate: Date.UTC(2026, 10, 1) }),
        row({ stockId: 2, quantity: 10, version: 7, expiryDate: Date.UTC(2026, 11, 1) }),
      ],
      6,
      NOW,
    );
    expect(plan.shortfall).toBe(0);
    expect(plan.usedApprovalId).toBeNull();
    expect(plan.allocations).toEqual([
      { stockId: 1, lotId: 1, locationId: 1, quantity: 4, before: 4, after: 0, version: 3, negative: false },
      { stockId: 2, lotId: 2, locationId: 1, quantity: 2, before: 10, after: 8, version: 7, negative: false },
    ]);
  });

  it('承認が無ければ不足分は shortfall のまま (Coordinator が 409 にする)', () => {
    const plan = planConsumption([row({ stockId: 1, quantity: 3 })], 5, NOW);
    expect(plan.shortfall).toBe(2);
    expect(plan.usedApprovalId).toBeNull();
  });

  it('承認済みレコードがあれば、不足分だけ対象在庫をマイナスにしてよい', () => {
    const plan = planConsumption([row({ stockId: 1, quantity: 3, version: 2 })], 5, NOW, {
      id: 42,
      stockId: 1,
      quantity: 10,
    });
    expect(plan.shortfall).toBe(0);
    expect(plan.usedApprovalId).toBe(42);
    expect(plan.allocations).toEqual([
      { stockId: 1, lotId: 1, locationId: 1, quantity: 5, before: 3, after: -2, version: 2, negative: true },
    ]);
  });

  it('承認数量を超える不足は許可しない', () => {
    const plan = planConsumption([row({ stockId: 1, quantity: 3 })], 20, NOW, {
      id: 42,
      stockId: 1,
      quantity: 10,
    });
    expect(plan.shortfall).toBe(17);
    expect(plan.usedApprovalId).toBeNull();
  });

  it('在庫 0 の承認対象にもマイナス配分を作れる', () => {
    const plan = planConsumption([row({ stockId: 1, quantity: 0, version: 5 })], 4, NOW, {
      id: 7,
      stockId: 1,
      quantity: 4,
    });
    expect(plan.shortfall).toBe(0);
    expect(plan.allocations).toEqual([
      { stockId: 1, lotId: 1, locationId: 1, quantity: 4, before: 0, after: -4, version: 5, negative: true },
    ]);
  });

  it('期限切れロットには承認があってもマイナス配分しない', () => {
    const plan = planConsumption(
      [row({ stockId: 1, quantity: 0, expiryDate: Date.UTC(2026, 9, 1) })],
      4,
      NOW,
      { id: 7, stockId: 1, quantity: 4 },
    );
    expect(plan.shortfall).toBe(4);
    expect(plan.usedApprovalId).toBeNull();
  });

  it('承認対象が候補に無ければ使えない', () => {
    const plan = planConsumption([row({ stockId: 1, quantity: 1 })], 5, NOW, {
      id: 7,
      stockId: 999,
      quantity: 10,
    });
    expect(plan.shortfall).toBe(4);
    expect(plan.usedApprovalId).toBeNull();
  });
});
