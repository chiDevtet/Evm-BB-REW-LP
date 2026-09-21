import { read, save, num } from './common.mjs';
// Persist the signed transaction before broadcast. Never sign a replacement while pending.
export async function settle(provider) {
  const pending = read('pending.json', null);
  if (!pending) return true;
  const network = await provider.getNetwork();
  if (String(network.chainId) !== pending.chain) throw Error('Pending transaction chain mismatch');
  let r = await provider.getTransactionReceipt(pending.hash);
  if (!r) {
    try {
      await provider.broadcastTransaction(pending.raw);
    } catch (e) {
      if (!/already known|nonce too low/i.test(e.message)) throw e;
    }
    return false;
  }
  if ((await provider.getBlockNumber()) - r.blockNumber + 1 < num('CONFIRMATIONS', 20, 1, 100))
    return false;
  save('pending.json', null);
  if (r.status !== 1) throw Error(`Transaction reverted: ${pending.hash}`);
  return true;
}
export async function send(ctx, request, label) {
  if (!(await settle(ctx.provider))) throw Error('Previous transaction pending');
  const populated = await ctx.runner.populateTransaction(request);
  const raw = await ctx.runner.signTransaction(populated);
  const { keccak256 } = await import('ethers');
  const hash = keccak256(raw);
  save('pending.json', {
    chain: String((await ctx.provider.getNetwork()).chainId),
    hash,
    raw,
    label,
  });
  await ctx.provider.broadcastTransaction(raw);
  console.log(label, hash);
  return hash;
}
