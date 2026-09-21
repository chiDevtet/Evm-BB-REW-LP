import { Contract, ZeroAddress, Wallet, getAddress } from 'ethers';
import { context, save, read, required, num, lock, json } from './common.mjs';
import { snapshot } from './holders.mjs';
import { distribution } from './merkle.mjs';
import { send } from './tx.mjs';
export async function prepare(ctx, id) {
  const x = await ctx.engine.epochs(id);
  if (x.ethBudget === 0n && x.lpBudget === 0n) return null;
  const s = await snapshot(ctx.provider, await ctx.engine.token(), Number(x.snapshotBlock));
  if (s.hash !== x.snapshotHash) throw Error('Epoch snapshot is no longer canonical');
  const hook = new Contract(
    await ctx.engine.hook(),
    ['function poolManager() view returns(address)'],
    ctx.provider,
  );
  const excluded = [
    ctx.engine.target,
    await ctx.engine.pair(),
    await hook.poolManager(),
    ...(process.env.EXCLUDED_ADDRESSES || '').split(',').filter(Boolean),
  ];
  for (const address of excluded) getAddress(address);
  if (BigInt(process.env.MIN_HOLDING_RAW || 1) < 1n)
    throw Error('MIN_HOLDING_RAW must be positive');
  const result = distribution({
    chain: num('CHAIN_ID', 4663),
    engine: ctx.engine.target,
    epoch: id,
    balances: s.balances,
    excluded,
    minimum: BigInt(process.env.MIN_HOLDING_RAW || 1),
    ethBudget: x.ethBudget,
    lpBudget: x.lpBudget,
  });
  result.snapshotBlock = s.block;
  result.snapshotHash = s.hash;
  result.excluded = excluded;
  result.minimum = process.env.MIN_HOLDING_RAW || '1';
  save(`epoch-${id}.json`, result);
  return result;
}
if (process.argv[1]?.endsWith('/epoch.mjs')) {
  const release = lock();
  try {
    const ctx = await context();
    const id = BigInt(process.argv[3] || (await ctx.engine.epochCount()));
    const action = process.argv[2] || 'prepare';
    if (action === 'prepare') console.log(json(await prepare(ctx, id)));
    else if (action === 'publish') {
      const d = read(`epoch-${id}.json`, null);
      if (!d) throw Error('Prepare and review epoch first');
      const runner = new Wallet(required('PUBLISHER_PRIVATE_KEY'), ctx.provider);
      if ((await ctx.engine.publisher()).toLowerCase() !== runner.address.toLowerCase())
        throw Error('Wrong publisher');
      const x = await ctx.engine.epochs(id);
      if ((await ctx.provider.getBlock(Number(x.snapshotBlock))).hash !== d.snapshotHash)
        throw Error('Snapshot mismatch');
      const tx = await ctx.engine.publishRoot.populateTransaction(id, d.root);
      await send({ ...ctx, runner }, tx, 'publish root');
    } else throw Error('Use prepare or publish');
  } finally {
    release();
  }
}
