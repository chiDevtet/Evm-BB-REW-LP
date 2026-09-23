import 'dotenv/config';
import {
  Wallet,
  Contract,
  AbiCoder,
  keccak256,
  ZeroAddress,
  parseEther,
  formatEther,
  getAddress,
} from 'ethers';
import { context, required } from '../keeper/common.mjs';
const ctx = await context();
const engine = ctx.engine;
const [action, ...values] = process.argv.slice(2);
const recipient = (value) => {
  const address = getAddress(value);
  if (address === ZeroAddress || address.toLowerCase() === engine.target.toLowerCase())
    throw Error('Recipient must be a nonzero address other than the engine');
  return address;
};
let tx;
if (action === 'recovery-status') {
  console.log('Owner:', await engine.owner(), 'Paused:', await engine.paused());
  console.log('Recoverable ETH:', formatEther(await engine.availableETH()));
  console.log('Protected holder ETH:', formatEther(await engine.reservedETH()));
  console.log('Protected holder LP (raw):', String(await engine.reservedLP()));
  process.exit(0);
} else if (action === 'recover-eth') {
  if (values.length !== 2) throw Error('Use recover-eth RECIPIENT ETH_AMOUNT|all');
  const amount = values[1] === 'all' ? await engine.availableETH() : parseEther(values[1]);
  if (amount <= 0n) throw Error('No positive unreserved amount to recover');
  tx = await engine.emergencyWithdrawETH.populateTransaction(recipient(values[0]), amount);
} else if (action === 'recover-token') {
  if (values.length !== 3) throw Error('Use recover-token TOKEN RECIPIENT RAW_AMOUNT|all');
  const asset = getAddress(values[0]);
  let amount;
  if (values[2] === 'all') {
    const token = new Contract(
      asset,
      ['function balanceOf(address) view returns(uint256)'],
      ctx.provider,
    );
    amount = await token.balanceOf(engine.target);
    if (asset.toLowerCase() === (await engine.pair()).toLowerCase())
      amount -= await engine.reservedLP();
  } else {
    if (!/^\d+$/.test(values[2])) throw Error('Token amount must be integer raw units');
    amount = BigInt(values[2]);
  }
  if (amount <= 0n) throw Error('No positive unreserved amount to recover');
  tx = await engine.emergencyWithdrawToken.populateTransaction(asset, recipient(values[1]), amount);
} else if (action === 'bind') {
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
else
  throw Error(
    'Use bind TOKEN | allocations B R L T | pause | unpause | publisher ADDRESS | recovery-status | recover-eth RECIPIENT ETH_AMOUNT|all | recover-token TOKEN RECIPIENT RAW_AMOUNT|all',
  );
console.log('Review transaction:', JSON.stringify(tx));
// Simulate every admin action before signing, including emergency recovery.
const owner = await engine.owner();
await ctx.provider.call({ ...tx, from: owner });
if (process.env.ADMIN_BROADCAST !== 'true') {
  console.log(
    'Simulation only. Set ADMIN_BROADCAST=true locally to send. Multisigs can submit the printed calldata.',
  );
} else {
  const signer = new Wallet(required('OWNER_PRIVATE_KEY'), ctx.provider);
  if (signer.address.toLowerCase() !== owner.toLowerCase()) throw Error('Wrong owner key');
  const sent = await signer.sendTransaction(tx);
  console.log(sent.hash);
  await sent.wait();
}
