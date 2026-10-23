import { describe, expect, it } from 'vitest';
import {
  compareFefo,
  dateOnlyUtcMs,
  isExpired,
  proposeFefoAllocation,
  type FefoCandidate,
} from '../src/fefo';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0); // 2026-10-24 12:00 UTC

function candidate(partial: Partial<FefoCandidate> & { stockId: number }): FefoCandidate {
  return {
    lotId: partial.stockId,
    expiryDate: null,
    quantity: 10,
    receivedAt: NOW - 30 * DAY,
    ...partial,
  };
}

describe('isExpired', () => {
  it('期限なしは期限切れにならない', () => {
    expect(isExpired(null, NOW)).toBe(false);
  });
  it('期限当日はまだ消費可能 (期限切れではない)', () => {
    expect(isExpired(Date.UTC(2026, 9, 24), NOW)).toBe(false);
  });
  it('前日が期限なら期限切れ', () => {
    expect(isExpired(Date.UTC(2026, 9, 23), NOW)).toBe(true);
  });
});

describe('compareFefo / proposeFefoAllocation', () => {
  it('期限が近い順に配分し、期限なしは後回し', () => {
    const proposal = proposeFefoAllocation(
      [
        candidate({ stockId: 1, expiryDate: null, quantity: 5 }),
        candidate({ stockId: 2, expiryDate: Date.UTC(2026, 11, 1), quantity: 5 }),
        candidate({ stockId: 3, expiryDate: Date.UTC(2026, 10, 1), quantity: 5 }),
      ],
      7,
      NOW,
    );
    expect(proposal.allocations).toEqual([
      { stockId: 3, lotId: 3, quantity: 5 },
      { stockId: 2, lotId: 2, quantity: 2 },
    ]);
    expect(proposal.shortfall).toBe(0);
  });

  it('期限切れロットは配分対象から除外し、不足分を shortfall で返す', () => {
    const proposal = proposeFefoAllocation(
      [
        candidate({ stockId: 1, expiryDate: Date.UTC(2026, 9, 1), quantity: 100 }),
        candidate({ stockId: 2, expiryDate: Date.UTC(2026, 10, 1), quantity: 3 }),
      ],
      10,
      NOW,
    );
    expect(proposal.allocations).toEqual([{ stockId: 2, lotId: 2, quantity: 3 }]);
    expect(proposal.shortfall).toBe(7);
  });

  it('同期限では receivedAt が古い順、同条件では stockId 昇順', () => {
    const expiry = Date.UTC(2026, 10, 1);
    const sorted = [
      candidate({ stockId: 9, expiryDate: expiry, receivedAt: NOW - 10 * DAY }),
      candidate({ stockId: 5, expiryDate: expiry, receivedAt: NOW - 20 * DAY }),
      candidate({ stockId: 3, expiryDate: expiry, receivedAt: NOW - 20 * DAY }),
    ].sort(compareFefo);
    expect(sorted.map((c) => c.stockId)).toEqual([3, 5, 9]);
  });

  it('数量 0 の候補は使わない', () => {
    const proposal = proposeFefoAllocation([candidate({ stockId: 1, quantity: 0 })], 1, NOW);
    expect(proposal.allocations).toEqual([]);
    expect(proposal.shortfall).toBe(1);
  });

  it('不正な要求数量は例外', () => {
    expect(() => proposeFefoAllocation([], 0, NOW)).toThrow();
    expect(() => proposeFefoAllocation([], 1.5, NOW)).toThrow();
  });

  it('dateOnlyUtcMs は UTC 日単位に切り捨てる', () => {
    expect(dateOnlyUtcMs(NOW)).toBe(Date.UTC(2026, 9, 24));
  });
});
