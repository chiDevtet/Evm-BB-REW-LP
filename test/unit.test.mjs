import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, leaf, combine } from '../keeper/merkle.mjs';
import { applyTransfer } from '../keeper/holders.mjs';
import { sqrt } from '../keeper/plan.mjs';
const a = '0x0000000000000000000000000000000000000001',
  b = '0x0000000000000000000000000000000000000002',
  c = '0x0000000000000000000000000000000000000003',
  zero = '0x0000000000000000000000000000000000000000';
test('holder accounting tracks mint, transfer, self transfer and rejects incomplete history', () => {
  const x = {};
  applyTransfer(x, zero, a, 100n);
  applyTransfer(x, a, b, 25n);
  applyTransfer(x, a, a, 5n);
  assert.equal(x[a], '75');
  assert.equal(x[b], '25');
  assert.throws(() => applyTransfer(x, c, a, 1n));
});
test('proportional distribution excludes custody and proofs verify for odd leaves', () => {
  const d = distribution({
    chain: 4663,
    engine: a,
    epoch: 1,
    balances: { [a]: '10', [b]: '20', [c]: '30', [zero]: '900' },
    ethBudget: 600n,
    lpBudget: 60n,
  });
  assert.equal(d.eligible, 3);
  assert.equal(d.rows[1].eth, '200');
  for (const r of d.rows) {
    const h = r.proof.reduce(combine, leaf(4663, a, 1, r.address, r.eth, r.lp));
    assert.equal(h, d.root);
  }
  assert.notEqual(leaf(4663, a, 1, a, 100n, 10n), leaf(4663, a, 2, a, 100n, 10n));
});
test('rounding never exceeds budgets and no-holder epoch is rejected', () => {
  const d = distribution({
    chain: 4663,
    engine: a,
    epoch: 1,
    balances: { [a]: '1', [b]: '2' },
    ethBudget: 5n,
    lpBudget: 7n,
  });
  assert.equal(
    d.rows.reduce((n, r) => n + BigInt(r.eth), 0n),
    4n,
  );
  assert.throws(() =>
    distribution({ chain: 4663, engine: a, epoch: 1, balances: {}, ethBudget: 1n, lpBudget: 1n }),
  );
});
test('integer sqrt matches initial V2 mint arithmetic', () => {
  for (const n of [0n, 1n, 2n, 100n, 10n ** 36n + 99n]) {
    const r = sqrt(n);
    assert(r * r <= n && (r + 1n) * (r + 1n) > n);
  }
});
