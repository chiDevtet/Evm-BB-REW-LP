import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Contract, JsonRpcProvider, Wallet, getAddress } from 'ethers';
export const dir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dir, { recursive: true });
export const json = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
export function save(name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p + '.tmp', json(value), { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
}
export function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export function required(k) {
  if (!process.env[k]) throw Error(`${k} required`);
  return process.env[k];
}
export function num(k, d, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(process.env[k] ?? d);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`Invalid ${k}`);
  return n;
}
export const abi = JSON.parse(fs.readFileSync('artifacts/UtilityEngine.json', 'utf8')).abi;
export async function context(write = false) {
  const provider = new JsonRpcProvider(required('RPC_URL'));
  if ((await provider.getNetwork()).chainId !== BigInt(num('CHAIN_ID', 4663)))
    throw Error('Wrong chain');
  const runner = write ? new Wallet(required('KEEPER_PRIVATE_KEY'), provider) : provider;
  const address = getAddress(required('ENGINE_ADDRESS'));
  if ((await provider.getCode(address)) === '0x') throw Error('Engine not deployed');
  const identity = {
    chain: String((await provider.getNetwork()).chainId),
    engine: address.toLowerCase(),
  };
  const stored = read('identity.json', null);
  if (stored && (stored.chain !== identity.chain || stored.engine !== identity.engine))
    throw Error('Data directory belongs to another chain/engine');
  if (!stored) save('identity.json', identity);
  return { provider, runner, engine: new Contract(address, abi, runner) };
}
export function lock() {
  const p = path.join(dir, 'worker.lock');
  try {
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
  } catch {
    throw Error(
      'Worker lock exists. Confirm prior process stopped before removing data/worker.lock',
    );
  }
  const release = () => {
    try {
      fs.unlinkSync(p);
    } catch {}
  };
  process.once('exit', release);
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  return release;
}
