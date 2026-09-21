import 'dotenv/config';
import { Wallet, Contract, AbiCoder, keccak256, ZeroAddress } from 'ethers';
import { context, required } from '../keeper/common.mjs';
const ctx = await context();
const engine = ctx.engine;
const [action, ...values] = process.argv.slice(2);
let tx;
if (action === 'bind') {
  const token = values[0] || required('TOKEN_ADDRESS');
  const id = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,uint24,int24,address)'],
      [[ZeroAddress, token, 0, 60, await engine.hook()]],
    ),
  );
  tx = await engine.bind.populateTransaction(token, id);
} else if (action === 'allocations') {
  if (values.length !== 4 || values.some((v) => !/^\d+$/.test(v)))
    throw Error('Expected burn rewards liquidity treasuryLP in basis points');
  tx = await engine.setAllocations.populateTransaction(...values);
} else if (action === 'pause' || action === 'unpause')
  tx = await engine.setPaused.populateTransaction(action === 'pause');
else if (action === 'publisher') tx = await engine.setPublisher.populateTransaction(values[0]);
else throw Error('Use bind TOKEN | allocations B R L T | pause | unpause | publisher ADDRESS');
console.log('Review transaction:', JSON.stringify(tx));
if (process.env.ADMIN_BROADCAST !== 'true') {
  console.log(
    'Simulation only. Set ADMIN_BROADCAST=true locally to send. Multisigs can submit the printed calldata.',
  );
  await ctx.provider.call({ ...tx, from: await engine.owner() });
} else {
  const signer = new Wallet(required('OWNER_PRIVATE_KEY'), ctx.provider);
  const sent = await signer.sendTransaction(tx);
  console.log(sent.hash);
  await sent.wait();
}
