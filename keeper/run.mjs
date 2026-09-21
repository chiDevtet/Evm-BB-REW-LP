import { ZeroAddress, Wallet } from 'ethers';
import { context, num, read, save, lock, json, required } from './common.mjs';
import { plan } from './plan.mjs';
import { prepare } from './epoch.mjs';
import { settle, send } from './tx.mjs';
const release = lock();
const dry = process.env.DRY_RUN !== 'false';
async function cycle() {
  const ctx = await context(!dry);
  if (dry && read('pending.json', null)) {
    console.log('Pending transaction; dry run will not rebroadcast');
    return;
  }
  if (!dry && !(await settle(ctx.provider))) return;
  const { engine, provider } = ctx;
  if (!dry && (await engine.keeper()).toLowerCase() !== ctx.runner.address.toLowerCase())
    throw Error('Wrong keeper key');
  // Pay confirmed epochs first. One bounded transaction per cycle; restart-safe paid bitmap.
  const count = Number(await engine.epochCount());
  for (let id = 1; id <= count; id++) {
    const x = await engine.epochs(id);
    if (
      Number(x.createdBlock) >
      (await provider.getBlockNumber()) - num('CONFIRMATIONS', 20, 1, 100)
    )
      continue;
    let d = read(`epoch-${id}.json`, null);
    if (!d) d = await prepare(ctx, id);
    if (!d) continue;
    if ((await provider.getBlock(Number(x.snapshotBlock))).hash !== x.snapshotHash)
      throw Error('Epoch reorg: operator review required');
    if (x.root === '0x' + '0'.repeat(64)) {
      if (!dry && process.env.AUTO_PUBLISH === 'true') {
        const publisher = new Wallet(required('PUBLISHER_PRIVATE_KEY'), provider);
        if ((await engine.publisher()).toLowerCase() !== publisher.address.toLowerCase())
          throw Error('Wrong publisher key');
        await send(
          { ...ctx, runner: publisher },
          await engine.publishRoot.populateTransaction(id, d.root),
          'publish holder manifest',
        );
        return;
      }
      continue;
    }
    if (d.root !== x.root) throw Error('Published root differs from local manifest');
    const batch = [];
    for (const row of d.rows) {
      if (BigInt(row.eth) + BigInt(row.lp) === 0n || (await engine.paid(id, row.address))) continue;
      batch.push([id, row.address, row.eth, row.lp, row.proof]);
      if (batch.length >= num('PAYOUT_BATCH_SIZE', 25, 1, 50)) break;
    }
    if (batch.length) {
      if (dry) console.log('Would pay', batch.length, 'holders in epoch', id);
      else {
        await send(ctx, await engine.payBatch.populateTransaction(batch), 'holder payout batch');
        return;
      }
    }
  }
  if (await engine.paused()) return;
  if ((await engine.pendingFees()) > 0n) {
    if (dry) console.log('Would collect', String(await engine.pendingFees()));
    else {
      await send(ctx, await engine.collect.populateTransaction(), 'collect fees');
      return;
    }
  }
  const head = await provider.getBlock('latest');
  if (
    BigInt(head.timestamp) <
    (await engine.lastProcessedAt()) + BigInt(Math.max(600, num('CADENCE_SECONDS', 600, 600)))
  )
    return;
  const p = await plan(ctx);
  if (!p) return;
  // Materialize and reconcile the holder snapshot before spending funds.
  const { snapshot } = await import('./holders.mjs');
  await snapshot(provider, p.token, p.snapshot);
  save('last-plan.json', { ...p, createdAt: new Date().toISOString(), dry });
  console.log(json({ event: 'plan', ...p, dry }));
  if (!dry) {
    await engine.process.staticCall(...p.args);
    await send(ctx, await engine.process.populateTransaction(...p.args), 'process utilities');
  }
}
try {
  do {
    try {
      await cycle();
      save('health.json', { ok: true, dry, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error(e.message);
      save('health.json', {
        ok: false,
        dry,
        error: e.shortMessage || e.message,
        updatedAt: new Date().toISOString(),
      });
      if (process.argv.includes('--once')) process.exitCode = 1;
    }
    if (process.argv.includes('--once')) break;
    await new Promise((r) => setTimeout(r, num('POLL_SECONDS', 60, 5) * 1000));
  } while (true);
} finally {
  release();
}
