import { Contract, toQuantity } from 'ethers';

export const ARB_SYS = '0x0000000000000000000000000000000000000064';
export const arbABI = [
  'function arbBlockNumber() view returns(uint256)',
  'function arbBlockHash(uint256) view returns(bytes32)',
];

// Pin the RPC and precompile reads to the same real L2 block, avoiding head races.
export async function checkArbSys(provider, block = 'latest') {
  if ((await provider.getNetwork()).chainId !== 4663n) throw Error('Expected Robinhood chain 4663');
  const head = await provider.getBlock(block);
  if (!head || head.number < 1) throw Error('Missing Robinhood block');
  const blockTag = toQuantity(head.number);
  const arb = new Contract(ARB_SYS, arbABI, provider);
  const number = await arb.arbBlockNumber({ blockTag }).catch((error) => {
    throw Error(
      `ArbSys number read failed at ${head.number}: ${error.info?.error?.message || error.shortMessage || 'RPC error'}`,
    );
  });
  if (number !== BigInt(head.number)) throw Error('ArbSys/RPC block number mismatch');
  const previous = await provider.getBlock(head.number - 1);
  const hash = await arb.arbBlockHash(head.number - 1, { blockTag }).catch((error) => {
    throw Error(
      `ArbSys hash read failed at ${head.number}: ${error.info?.error?.message || error.shortMessage || 'RPC error'}`,
    );
  });
  if (!previous || hash.toLowerCase() !== previous.hash.toLowerCase())
    throw Error('ArbSys/RPC block hash mismatch');
  return { head, previous, number, hash };
}
