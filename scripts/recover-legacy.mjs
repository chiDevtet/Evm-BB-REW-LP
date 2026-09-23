import 'dotenv/config';
import { Wallet, getAddress, ZeroAddress, formatEther } from 'ethers';
import { context, read, save, required, lock, json } from '../keeper/common.mjs';
import { finishLegacyRecovery } from './legacy-recovery-core.mjs';

const release = lock();
try {
  const { provider, engine } = await context();
  if ((await provider.getNetwork()).chainId !== 4663n) throw Error('Expected Robinhood chain 4663');
  let modern = false;
  try {
    modern = (await engine.ARB_SYS()) !== ZeroAddress;
  } catch (error) {
    // Only an absent selector identifies the old ABI; an RPC outage does not.
    if (error.code !== 'CALL_EXCEPTION' || error.data !== '0x') throw error;
  }
  if (modern)
    throw Error('This engine has emergencyWithdrawETH; use admin pause/recover-eth instead');
  const owner = await engine.owner();
  const recipient = getAddress(process.env.RECOVERY_RECIPIENT || owner);
  if (recipient === ZeroAddress || recipient.toLowerCase() === engine.target.toLowerCase())
    throw Error('Invalid recipient');
  let journal = read('legacy-recovery.json', null);
  if (journal) {
    if (
      journal.chain !== '4663' ||
      journal.engine.toLowerCase() !== engine.target.toLowerCase() ||
      journal.owner.toLowerCase() !== owner.toLowerCase() ||
      journal.recipient.toLowerCase() !== recipient.toLowerCase()
    )
      throw Error('Recovery journal does not match this engine/owner/recipient');
  } else {
    if (
      (await engine.epochCount()) !== 0n ||
      (await engine.reservedETH()) !== 0n ||
      (await engine.reservedLP()) !== 0n
    )
      throw Error(
        'Legacy recovery requires an unused test engine with no existing epochs or holder reserves',
      );
    const amount = await engine.availableETH();
    if (amount === 0n) throw Error('No unallocated test ETH');
    journal = {
      chain: '4663',
      engine: engine.target,
      owner,
      recipient,
      amount: String(amount),
      complete: false,
    };
  }
  console.log(json({ ...journal, eth: formatEther(journal.amount) }));
  console.log(
    'Retires this test engine: pause; assign owner as keeper/publisher; set 100% ETH rewards; process one parent-clock recovery epoch; pause; publish one recipient leaf; pay. No swaps or LP deposits. Do not restart its normal keeper.',
  );
  const getSnapshot = async () => {
    const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
    if (!head?.l1BlockNumber)
      throw Error('RPC must expose l1BlockNumber for the legacy opcode clock');
    const snapshot = BigInt(head.l1BlockNumber) - 1n;
    if (snapshot < 1n) throw Error('Invalid parent block');
    return { snapshot, deadline: BigInt(head.timestamp) + 120n };
  };
  console.log('Legacy recovery snapshot:', String((await getSnapshot()).snapshot));
  if (!process.argv.includes('--broadcast')) {
    console.log(
      'READ ONLY. Only for your own unallocated test deposit. Stop the keeper and review recipient/amount; add --broadcast to execute with OWNER_PRIVATE_KEY. Re-running resumes the same journal.',
    );
  } else {
    const signer = new Wallet(required('OWNER_PRIVATE_KEY'), provider);
    if (signer.address.toLowerCase() !== owner.toLowerCase()) throw Error('Wrong owner key');
    save('legacy-recovery.json', journal);
    try {
      await finishLegacyRecovery(engine.connect(signer), journal, getSnapshot, async (value) =>
        save('legacy-recovery.json', value),
      );
      console.log(
        'Recovered',
        formatEther(journal.amount),
        'ETH to',
        recipient,
        '; engine is paused.',
      );
    } catch (error) {
      // Stop new processing even if a later recovery step fails. Keep the journal to resume.
      try {
        if (!(await engine.paused())) await (await engine.connect(signer).setPaused(true)).wait();
      } catch {}
      throw error;
    }
  }
} finally {
  release();
}
