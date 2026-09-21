import { Interface, ZeroAddress, Contract } from 'ethers';
import { read, save, num, required } from './common.mjs';
const iface = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export function applyTransfer(balances, from, to, value) {
  from = from.toLowerCase();
  to = to.toLowerCase();
  const n = BigInt(value);
  if (from !== ZeroAddress) {
    const v = BigInt(balances[from] || 0) - n;
    if (v < 0n) throw Error('Incomplete token history: negative balance');
    balances[from] = v.toString();
  }
  if (to !== ZeroAddress) balances[to] = (BigInt(balances[to] || 0) + n).toString();
}
export async function snapshot(provider, token, target) {
  const chain = (await provider.getNetwork()).chainId.toString();
  const start = num('TOKEN_DEPLOY_BLOCK', NaN);
  if (target < start) throw Error('Snapshot predates token deployment');
  const initial = () => ({
    chain,
    token: token.toLowerCase(),
    start,
    block: start - 1,
    hash: null,
    balances: {},
  });
  let s = read('holders.json', initial());
  if (s.chain !== chain || s.token !== token.toLowerCase() || s.start !== start)
    throw Error('Holder state identity mismatch');
  if (s.hash && (await provider.getBlock(s.block))?.hash !== s.hash)
    throw Error('Holder checkpoint reorg: stop and rebuild holders.json from deployment');
  if (s.block > target) s = initial();
  const anchor = await provider.getBlock(target);
  if (!anchor) throw Error('Missing snapshot block');
  for (let from = s.block + 1; from <= target;) {
    const to = Math.min(target, from + num('LOG_CHUNK', 500, 1, 10000) - 1);
    const logs = await provider.getLogs({
      address: token,
      topics: [iface.getEvent('Transfer').topicHash],
      fromBlock: from,
      toBlock: to,
    });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    for (const log of logs) {
      const { args } = iface.parseLog(log);
      applyTransfer(s.balances, args.from, args.to, args.value);
    }
    s.block = to;
    s.hash = (await provider.getBlock(to)).hash;
    from = to + 1;
  }
  if ((await provider.getBlock(target)).hash !== anchor.hash)
    throw Error('Snapshot changed during indexing');
  const supply = await new Contract(
    token,
    ['function totalSupply() view returns(uint256)'],
    provider,
  ).totalSupply({ blockTag: target });
  if (Object.values(s.balances).reduce((a, v) => a + BigInt(v), 0n) !== supply)
    throw Error('Transfer history does not reconcile to totalSupply');
  save('holders.json', s);
  return s;
}
