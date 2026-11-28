import { allocateReceipt } from './receipt-allocation';

describe('receipt allocation in whole VND', () => {
  it('keeps the values of ten distinct orders', () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({
      amount: BigInt(10_000 + index * 1_000), assigneeIds: [String(index)],
    }));
    const result = allocateReceipt(145_000n, 0n, lines);
    expect(result.complete).toBe(true);
    for (const line of lines) {
      expect(result.shares).toContainEqual({ userId: line.assigneeIds[0], amount: Number(line.amount) });
    }
  });

  it('reconciles shared items and net tax, fee and discount with stable rounding', () => {
    const result = allocateReceipt(103n, 2n, [
      { amount: 100n, assigneeIds: ['c', 'b', 'a'] },
      { amount: 1n, assigneeIds: ['a'] },
    ]);
    expect(result.shares).toEqual(expect.arrayContaining([
      { userId: 'a', amount: 35 }, { userId: 'b', amount: 34 }, { userId: 'c', amount: 34 },
    ]));
  });

  it('shows the assigned portion but prevents finalizing incomplete or mismatched totals', () => {
    const result = allocateReceipt(96n, -5n, [
      { amount: 50n, assigneeIds: ['a'] }, { amount: 50n, assigneeIds: [] },
    ]);
    expect(result).toEqual({ subtotal: 100, difference: 1, unassigned: 1, complete: false,
      shares: [{ userId: 'a', amount: 50 }] });
  });
});
