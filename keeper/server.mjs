import express from 'express';
import fs from 'node:fs';
import { Contract, ZeroAddress, formatEther } from 'ethers';
import { context, read, abi, num } from './common.mjs';
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
let cache = null,
  cacheTime = 0;
app.get('/api/status', async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < 15000) return res.json(cache);
    if (!process.env.ENGINE_ADDRESS)
      return res.json({ configured: false, network: 'Robinhood Chain', chainId: 4663 });
    const { engine, provider } = await context();
    const names = [
      'token',
      'pair',
      'owner',
      'publisher',
      'treasury',
      'keeper',
      'paused',
      'burnBps',
      'rewardBps',
      'liquidityBps',
      'treasuryLpBps',
      'pendingFees',
      'availableETH',
      'reservedETH',
      'reservedLP',
      'totalProcessed',
      'totalBurned',
      'totalLpMinted',
      'epochCount',
      'lastProcessedAt',
    ];
    const vals = await Promise.all(names.map((n) => engine[n]()));
    const data = Object.fromEntries(
      names.map((n, i) => [n, typeof vals[i] === 'bigint' ? vals[i].toString() : vals[i]]),
    );
    let symbol = 'TOKEN',
      decimals = 18;
    if (data.token !== ZeroAddress) {
      const t = new Contract(
        data.token,
        ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'],
        provider,
      );
      symbol = await t.symbol();
      decimals = Number(await t.decimals());
    }
    const epochs = [];
    for (let i = Number(data.epochCount); i > Math.max(0, Number(data.epochCount) - 10); i--) {
      const x = await engine.epochs(i);
      epochs.push({
        id: i,
        snapshotBlock: x.snapshotBlock.toString(),
        ethBudget: x.ethBudget.toString(),
        lpBudget: x.lpBudget.toString(),
        ethPaid: x.ethPaid.toString(),
        lpPaid: x.lpPaid.toString(),
        published: x.root !== '0x' + '0'.repeat(64),
      });
    }
    const health = read('health.json', null);
    cache = {
      configured: true,
      engine: engine.target,
      network: 'Robinhood Chain',
      chainId: 4663,
      symbol,
      decimals,
      ...data,
      epochs,
      health: health ? { ok: health.ok, dry: health.dry, updatedAt: health.updatedAt } : null,
      updatedAt: new Date().toISOString(),
    };
    cacheTime = Date.now();
    res.json(cache);
  } catch (e) {
    console.error('status read failed:', e.shortMessage || e.message);
    res.status(503).json({ error: 'Chain data unavailable. Please retry.' });
  }
});
app.get('/api/epochs/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(400);
  const d = read(`epoch-${req.params.id}.json`, null);
  if (!d) return res.sendStatus(404);
  res.json(d);
});
app.get('/api/abi', (_, res) => res.json(abi));
app.use(express.static('web'));
app.listen(num('PORT', 3000, 1, 65535), process.env.HOST || '127.0.0.1', () =>
  console.log('Dashboard listening'),
);
