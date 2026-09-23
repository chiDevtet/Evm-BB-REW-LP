// Retirement path for the original test engine, which has no withdrawal function.
// Caller must establish that the unallocated deposit belongs to them and stop the keeper.
import { ZeroHash } from 'ethers';

export async function finishLegacyRecovery(engine, journal, getSnapshot, persist) {
  const owner = await engine.owner();
  if (
    owner.toLowerCase() !== journal.owner.toLowerCase() ||
    engine.target.toLowerCase() !== journal.engine.toLowerCase()
  )
    throw Error('Recovery journal identity mismatch');
  const amount = BigInt(journal.amount);
  if (amount <= 0n) throw Error('Empty recovery');
  const count = await engine.epochCount();
  if (count > 1n) throw Error('Unexpected epochs: stop for manual review');
  const send = async (tx) => {
    const receipt = await (await tx).wait();
    if (receipt.status !== 1) throw Error('Recovery transaction reverted');
  };
  if (!(await engine.paused())) await send(engine.setPaused(true));
  if (count === 0n) {
    if (
      (await engine.reservedETH()) !== 0n ||
      (await engine.reservedLP()) !== 0n ||
      (await engine.availableETH()) < amount
    )
      throw Error('Unexpected reserves or insufficient unallocated test funds');
    if ((await engine.keeper()).toLowerCase() !== owner.toLowerCase())
      await send(engine.setKeeper(owner));
    if ((await engine.publisher()).toLowerCase() !== owner.toLowerCase())
      await send(engine.setPublisher(owner));
    await send(engine.setAllocations(0, 10000, 0, 0));
    // The journal is saved before process so a lost receipt can be reconciled from epoch 1.
    await persist(journal);
    await send(engine.setPaused(false));
    const { snapshot, deadline } = await getSnapshot();
    await engine.process.staticCall(amount, 0, 0, 0, 0, deadline, snapshot);
    await send(engine.process(amount, 0, 0, 0, 0, deadline, snapshot));
    await send(engine.setPaused(true));
  }
  const epoch = await engine.epochs(1);
  if (epoch.ethBudget !== amount || epoch.lpBudget !== 0n || epoch.lpPaid !== 0n)
    throw Error('Recovery epoch does not match the recorded test deposit');
  const root = await engine.leaf(1, journal.recipient, amount, 0);
  if (epoch.root === ZeroHash) {
    if ((await engine.publisher()).toLowerCase() !== owner.toLowerCase())
      throw Error('Recovery publisher changed');
    await send(engine.publishRoot(1, root));
  } else if (epoch.root !== root) throw Error('Unexpected root: stop for manual review');
  if (!(await engine.paid(1, journal.recipient)))
    await send(engine.pay(1, journal.recipient, amount, 0, []));
  const deferred = await engine.deferredETH(journal.recipient);
  if (deferred > 0n)
    throw Error(
      'Recipient rejected ETH: it must call withdrawDeferred(to); do not retry to another recipient',
    );
  if ((await engine.reservedETH()) !== 0n) throw Error('Unexpected remaining ETH reserve');
  journal.complete = true;
  await persist(journal);
  return journal;
}
