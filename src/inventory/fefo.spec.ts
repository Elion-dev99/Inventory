import { isExpired, proposeFefoAllocation, type FefoCandidate } from './fefo';

const NOW = new Date('2026-10-24T00:00:00.000Z');

function candidate(partial: Partial<FefoCandidate> & { stockId: bigint }): FefoCandidate {
  return {
    lotId: partial.stockId,
    expiryDate: null,
    quantity: 10,
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('proposeFefoAllocation (FEFO)', () => {
  it('有効期限が近いロットから順に割り当てる', () => {
    const proposal = proposeFefoAllocation(
      [
        candidate({ stockId: 1n, expiryDate: new Date('2027-01-01T00:00:00.000Z'), quantity: 5 }),
        candidate({ stockId: 2n, expiryDate: new Date('2026-12-01T00:00:00.000Z'), quantity: 5 }),
        candidate({ stockId: 3n, expiryDate: null, quantity: 5 }),
      ],
      7,
      NOW,
    );
    expect(proposal.shortfall).toBe(0);
    expect(proposal.allocations).toEqual([
      { stockId: 2n, lotId: 2n, quantity: 5 },
      { stockId: 1n, lotId: 1n, quantity: 2 },
    ]);
  });

  it('期限切れロットを除外し、不足分を shortfall で返す', () => {
    const proposal = proposeFefoAllocation(
      [
        candidate({ stockId: 1n, expiryDate: new Date('2026-10-23T00:00:00.000Z'), quantity: 100 }),
        candidate({ stockId: 2n, expiryDate: new Date('2026-11-01T00:00:00.000Z'), quantity: 3 }),
      ],
      10,
      NOW,
    );
    expect(proposal.allocations).toEqual([{ stockId: 2n, lotId: 2n, quantity: 3 }]);
    expect(proposal.shortfall).toBe(7);
  });

  it('期限当日はまだ消費可能', () => {
    expect(isExpired(new Date('2026-10-24T00:00:00.000Z'), NOW)).toBe(false);
    expect(isExpired(new Date('2026-10-23T23:59:59.000Z'), NOW)).toBe(true);
    expect(isExpired(null, NOW)).toBe(false);
  });

  it('残高ゼロのロットはスキップし、同期限では入庫が古い順になる', () => {
    const proposal = proposeFefoAllocation(
      [
        candidate({
          stockId: 5n,
          expiryDate: new Date('2026-12-01T00:00:00.000Z'),
          quantity: 4,
          receivedAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
        candidate({
          stockId: 4n,
          expiryDate: new Date('2026-12-01T00:00:00.000Z'),
          quantity: 4,
          receivedAt: new Date('2026-01-15T00:00:00.000Z'),
        }),
        candidate({ stockId: 6n, expiryDate: new Date('2026-11-01T00:00:00.000Z'), quantity: 0 }),
      ],
      5,
      NOW,
    );
    expect(proposal.allocations).toEqual([
      { stockId: 4n, lotId: 4n, quantity: 4 },
      { stockId: 5n, lotId: 5n, quantity: 1 },
    ]);
  });

  it('不正な数量はエラー', () => {
    expect(() => proposeFefoAllocation([], 0, NOW)).toThrow();
    expect(() => proposeFefoAllocation([], -1, NOW)).toThrow();
  });
});
