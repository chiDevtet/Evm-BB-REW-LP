import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProvider, Contract, ContractFactory } from 'ethers';
import { ARB_SYS } from '../../scripts/chain-check.mjs';

const require = createRequire(import.meta.url);
export const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/${name}.json`, 'utf8'));
export async function deploy(signer, name, args = []) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
export async function startAnvil(extra = []) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const child = spawn(
    process.execPath,
    [
      require.resolve('@foundry-rs/anvil/bin.mjs'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '4663',
      '--hardfork',
      'cancun',
      '--silent',
      ...extra,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    output += b;
  });
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, 4663, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const close = async () => {
    provider.destroy();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
  try {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw Error(`Anvil exited: ${output}`);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(1000),
        });
        if ((await response.json()).result === '0x1237') return { provider, close, url };
      } catch {}
      await delay(100);
    }
    throw Error(`Anvil did not start: ${output}`);
  } catch (error) {
    await close();
    throw error;
  }
}
export async function installArbSys(provider, signer, offset = 1_000_000n) {
  await provider.send('anvil_setCode', [ARB_SYS, artifact('TestArbSys').deployedBytecode]);
  const arb = new Contract(ARB_SYS, artifact('TestArbSys').abi, signer);
  await (await arb.configure(offset, false)).wait();
  return arb;
}
