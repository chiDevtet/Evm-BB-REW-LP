import { AbiCoder, keccak256, concat, ZeroAddress } from 'ethers';
const coder = AbiCoder.defaultAbiCoder();
export const leaf = (chain, engine, epoch, address, eth, lp) =>
  keccak256(
    keccak256(
      coder.encode(
        ['uint256', 'address', 'uint256', 'address', 'uint256', 'uint256'],
        [chain, engine, epoch, address, eth, lp],
      ),
    ),
  );
export const combine = (a, b) =>
  keccak256(concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
export function distribution({
  chain,
  engine,
  epoch,
  balances,
  excluded = [],
  minimum = 1n,
  ethBudget,
  lpBudget,
}) {
  const skip = new Set(
    [ZeroAddress, '0x000000000000000000000000000000000000dead', ...excluded].map((a) =>
      a.toLowerCase(),
    ),
  );
  const holders = Object.entries(balances)
    .filter(([a, n]) => !skip.has(a.toLowerCase()) && BigInt(n) >= minimum)
    .sort(([a], [b]) => a.localeCompare(b));
  const total = holders.reduce((s, [, n]) => s + BigInt(n), 0n);
  if (total === 0n) throw Error('No eligible holders');
  const rows = holders.map(([address, n]) => ({
    address,
    eth: ((BigInt(ethBudget) * BigInt(n)) / total).toString(),
    lp: ((BigInt(lpBudget) * BigInt(n)) / total).toString(),
  }));
  const levels = [rows.map((r) => leaf(chain, engine, epoch, r.address, r.eth, r.lp))];
  while (levels.at(-1).length > 1) {
    const last = levels.at(-1),
      next = [];
    for (let i = 0; i < last.length; i += 2)
      next.push(i + 1 < last.length ? combine(last[i], last[i + 1]) : last[i]);
    levels.push(next);
  }
  rows.forEach((r, i) => {
    r.proof = [];
    for (let level = 0; level < levels.length - 1; level++) {
      const sibling = i ^ 1;
      if (sibling < levels[level].length) r.proof.push(levels[level][sibling]);
      i = Math.floor(i / 2);
    }
  });
  return {
    chain: String(chain),
    engine,
    epoch: String(epoch),
    root: levels.at(-1)[0],
    eligible: rows.length,
    totalWeight: total.toString(),
    rows,
  };
}
