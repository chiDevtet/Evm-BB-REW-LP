// Read-only Nitro simulation: candidate runtime override, real storage, native
// ArbSys and real routers. Complements (does not replace) the multi-round fork.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import solc from 'solc';
import { Contract, FetchRequest, JsonRpcProvider, getAddress, toBeHex, zeroPadValue } from 'ethers';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-native-'));
process.env.DATA_DIR = temp;
const request = new FetchRequest(
  process.env.FORK_RPC_URL || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
);
request.timeout = 30000;
const provider = new JsonRpcProvider(request, 4663, {
  staticNetwork: true,
  batchMaxCount: 1,
  cacheTimeout: -1,
});
const report = {
  status: 'FAILED',
  mode: 'native Robinhood eth_call with candidate code override; no broadcast',
};
try {
  if (BigInt(await provider.send('eth_chainId', [])) !== 4663n)
    throw Error('Expected Robinhood 4663');
  const address = getAddress(process.env.FORK_ENGINE_ADDRESS || process.env.ENGINE_ADDRESS || '');
  report.engine = address;
  const artifact = JSON.parse(fs.readFileSync('artifacts/UtilityEngine.json', 'utf8'));
  const engine = new Contract(address, artifact.abi, provider);
  if (await engine.paused())
    throw Error(
      'Fixture is paused; use the local fork gate to change its state, never unpause live just for this test',
    );
  const input = JSON.parse(fs.readFileSync('artifacts/compiler-input.json', 'utf8'));
  input.settings.outputSelection['*']['*'].push('evm.deployedBytecode.immutableReferences');
  input.settings.outputSelection['*'][''] = ['ast'];
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors?.some((e) => e.severity === 'error')) throw Error('Candidate compilation failed');
  const names = {};
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable')
      names[node.id] = node.name;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(out.sources['UtilityEngine.sol'].ast);
  const code = out.contracts['UtilityEngine.sol'].UtilityEngine.evm.deployedBytecode;
  let runtime = code.object;
  report.immutables = {};
  for (const [id, locations] of Object.entries(code.immutableReferences)) {
    const name = names[id];
    if (!name || !['hook', 'vault', 'router', 'v2', 'sixField'].includes(name))
      throw Error('Unknown immutable');
    const value = await engine[name]();
    report.immutables[name] = value;
    const encoded =
      typeof value === 'boolean' ? toBeHex(Number(value), 32) : zeroPadValue(value, 32);
    for (const { start, length } of locations) {
      if (length !== 32) throw Error('Unexpected immutable width');
      runtime =
        runtime.slice(0, start * 2) + encoded.slice(2) + runtime.slice((start + length) * 2);
    }
  }
  process.env.MAX_PROCESS_ETH = process.env.FORK_PROCESS_ETH || '0.001';
  process.env.MIN_PROCESS_ETH = process.env.MAX_PROCESS_ETH;
  const { plan } = await import('../../keeper/plan.mjs');
  const planned = await plan({ provider, engine });
  if (!planned) throw Error('Fixture has insufficient unallocated ETH for the requested round');
  report.args = planned.args.map(String);
  report.snapshotBlock = planned.snapshot;
  const tx = {
    ...(await engine.process.populateTransaction(...planned.args)),
    from: await engine.keeper(),
  };
  report.result = await provider.send('eth_call', [
    tx,
    'latest',
    { [address]: { code: '0x' + runtime } },
  ]);
  if (report.result !== '0x') throw Error('Unexpected process result');
  report.status = 'PASSED';
} catch (error) {
  report.error = (error.shortMessage || error.message).split(request.url).join('[RPC_URL]');
  console.error(report.error);
  process.exitCode = 1;
} finally {
  provider.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  fs.writeFileSync('artifacts/robinhood-native-report.json', JSON.stringify(report, null, 2));
  console.log(`${report.status}: artifacts/robinhood-native-report.json`);
}
