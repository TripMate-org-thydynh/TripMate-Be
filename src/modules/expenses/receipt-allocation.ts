type Weight = { id: string; amount: bigint };

function proportional(amount: bigint, weights: Weight[]): Map<string, bigint> {
  const denominator = weights.reduce((sum, weight) => sum + weight.amount, 0n);
  const ranked = weights.map((weight) => ({
    id: weight.id,
    amount: (amount * weight.amount) / denominator,
    remainder: (amount * weight.amount) % denominator,
  }));
  ranked.sort((a, b) =>
    a.remainder === b.remainder ? a.id.localeCompare(b.id)
      : a.remainder > b.remainder ? -1 : 1,
  );
  let remaining = amount - ranked.reduce((sum, row) => sum + row.amount, 0n);
  for (const row of ranked) {
    if (!remaining) break;
    row.amount += 1n;
    remaining -= 1n;
  }
  return new Map(ranked.map(({ id, amount: share }) => [id, share]));
}

export function allocateReceipt(
  total: bigint,
  adjustment: bigint,
  lines: { amount: bigint; assigneeIds: string[] }[],
) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0n);
  const unassigned = lines.filter((line) => !line.assigneeIds.length).length;
  const difference = total - subtotal - adjustment;
  const weights = new Map<string, bigint>();
  // Fractional ownership of a shared item affects the distribution even below
  // one đồng. Use a common denominator so rounding happens only once.
  const scale = lines.reduce((lcm, line) => {
    const count = BigInt(Math.max(1, line.assigneeIds.length));
    let a = lcm;
    let b = count;
    while (b) [a, b] = [b, a % b];
    return (lcm / a) * count;
  }, 1n);
  for (const line of lines) {
    if (!line.assigneeIds.length) continue;
    const weight = (line.amount * scale) / BigInt(line.assigneeIds.length);
    for (const id of line.assigneeIds) {
      weights.set(id, (weights.get(id) ?? 0n) + weight);
    }
  }
  const assigned = lines.reduce((sum, line) => line.assigneeIds.length ? sum + line.amount : sum, 0n);
  const complete = unassigned === 0 && difference === 0n && subtotal > 0n;
  const shares = assigned
    ? proportional(complete ? total : assigned,
        [...weights].map(([id, amount]) => ({ id, amount })))
    : new Map<string, bigint>();
  return {
    subtotal: Number(subtotal),
    difference: Number(difference),
    unassigned,
    complete,
    shares: [...shares].map(([userId, amount]) => ({ userId, amount: Number(amount) })),
  };
}
