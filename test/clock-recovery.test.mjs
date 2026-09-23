import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, AbiCoder, keccak256, ZeroAddress, parseEther } from 'ethers';
import { finishLegacyRecovery } from '../scripts/legacy-recovery-core.mjs';
import { startAnvil, installArbSys, deploy, artifact } from './helpers/anvil.mjs';
import { ARB_SYS } from '../scripts/chain-check.mjs';

async function fixture(t) {
  const rpc = await startAnvil();
  t.after(() => rpc.close());
  const p = rpc.provider;
  const owner = await p.getSigner(0),
    keeper = await p.getSigner(1),
    recipient = await p.getSigner(2);
  const arb = await installArbSys(p, owner);
  const token = await deploy(owner, 'MockToken');
  const weth = await deploy(owner, 'MockToken');
  const hook = await deploy(owner, 'MockHook');
  const vault = await deploy(owner, 'MockVault', [hook.target]);
  const router = await deploy(owner, 'MockRouter', [token.target]);
  const v2 = await deploy(owner, 'MockV2', [weth.target]);
  await (await hook.configure(vault.target, token.target, ZeroAddress, ZeroAddress)).wait();
  const e = await deploy(owner, 'UtilityEngine', [
    owner.address,
    keeper.address,
    recipient.address,
    hook.target,
    router.target,
    v2.target,
    true,
  ]);
  const bind = async () => {
    await (await hook.configure(vault.target, token.target, e.target, ZeroAddress)).wait();
    const id = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint24,int24,address)'],
        [[ZeroAddress, token.target, 0, 60, hook.target]],
      ),
    );
    await (await e.bind(token.target, id)).wait();
  };
  const fund = async (value) => (await owner.sendTransaction({ to: e.target, value })).wait();
  const args = async (value, snapshot) => [
    value,
    1,
    1,
    1,
    1,
    (await p.getBlock('latest')).timestamp + 120,
    snapshot ?? (await arb.arbBlockNumber()) - 1n,
  ];
  return { p, owner, keeper, recipient, arb, token, e, bind, fund, args };
}

test('ArbSys rejects current/future/expired/zero snapshots and accepts the full 256-block window', async (t) => {
  const { p, owner, keeper, arb, e, bind, fund, args } = await fixture(t);
  await bind();
  await (await e.setAllocations(0, 10000, 0, 0)).wait();
  await fund(parseEther('1'));
  await (await e.setPaused(false)).wait();
  await p.send('anvil_mine', ['0x12c']);
  const current = await arb.arbBlockNumber();
  for (const number of [
    current,
    current + 1n,
    current - 257n,
    BigInt(await p.getBlockNumber()) - 1n,
  ])
    await assert.rejects(
      e.connect(keeper).process.staticCall(...(await args(1n, number))),
      /snapshot/,
    );
  await e.connect(keeper).process.staticCall(...(await args(1n, current - 256n)));
  await (await arb.configure(1_000_000n, true)).wait();
  await assert.rejects(e.connect(keeper).process.staticCall(...(await args(1n))), /snapshot/);
  await (await arb.configure(1_000_000n, false)).wait();
  await p.send('anvil_setCode', [ARB_SYS, '0x']);
  await assert.rejects(e.connect(keeper).process.staticCall(...(await args(1n, current - 1n))));
  assert.equal(await e.epochCount(), 0n);
  // A broken precompile must never prevent owner recovery.
  await (await e.setPaused(true)).wait();
  await (await e.emergencyWithdrawETH(owner.address, parseEther('1'))).wait();
  assert.equal(await e.availableETH(), 0n);
});

test('owner can recover 0.0034 ETH before binding; pause, recipient, amount and failed-send checks', async (t) => {
  const { p, owner, keeper, recipient, e, fund } = await fixture(t);
  const amount = parseEther('0.0034');
  await fund(amount);
  await assert.rejects(
    e.connect(keeper).emergencyWithdrawETH.staticCall(recipient.address, amount),
    /owner/,
  );
  await assert.rejects(e.emergencyWithdrawETH.staticCall(ZeroAddress, amount), /recipient/);
  await assert.rejects(e.emergencyWithdrawETH.staticCall(e.target, amount), /recipient/);
  await assert.rejects(e.emergencyWithdrawETH.staticCall(recipient.address, 0), /available/);
  await assert.rejects(
    e.emergencyWithdrawETH.staticCall(recipient.address, amount + 1n),
    /available/,
  );
  await (await e.setPaused(false)).wait();
  await assert.rejects(e.emergencyWithdrawETH.staticCall(recipient.address, amount), /pause first/);
  await (await e.setPaused(true)).wait();
  const reject = await deploy(owner, 'RejectETH');
  await assert.rejects(e.emergencyWithdrawETH.staticCall(reject.target, amount), /send/);
  assert.equal(await e.availableETH(), amount);
  const before = await p.getBalance(recipient.address);
  const receipt = await (await e.emergencyWithdrawETH(recipient.address, amount)).wait();
  const event = receipt.logs
    .map((l) => e.interface.parseLog(l))
    .find((l) => l?.name === 'EmergencyWithdrawal');
  assert.equal(event.args.asset, ZeroAddress);
  assert.equal(event.args.to, recipient.address);
  assert.equal(event.args.amount, amount);
  assert.equal(await p.getBalance(recipient.address), before + amount);
  assert.equal(await p.getBalance(e.target), 0n);
});

test('recovery protects unpublished, published and deferred holder budgets; payouts still work paused', async (t) => {
  const { p, owner, keeper, recipient, token, e, bind, fund, args } = await fixture(t);
  await bind();
  await fund(parseEther('1'));
  await (await e.setPaused(false)).wait();
  await (await e.connect(keeper).process(...(await args(parseEther('1'))))).wait();
  await (await e.setPaused(true)).wait();
  const lp = new Contract(await e.pair(), artifact('MockToken').abi, owner);
  const ethBudget = await e.reservedETH(),
    lpBudget = await e.reservedLP();
  const protectedFunds = async () => {
    await assert.rejects(e.emergencyWithdrawETH.staticCall(recipient.address, 1n), /available/);
    await assert.rejects(
      e.emergencyWithdrawToken.staticCall(lp.target, recipient.address, 1n),
      /available/,
    );
  };
  await protectedFunds(); // No root yet; still a holder liability.
  await fund(100n);
  await (await lp.mint(e.target, 50n)).wait();
  await (await token.mint(e.target, 25n)).wait();
  await assert.rejects(e.emergencyWithdrawETH.staticCall(recipient.address, 101n), /available/);
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(lp.target, recipient.address, 51n),
    /available/,
  );
  await (await e.emergencyWithdrawETH(recipient.address, 100n)).wait();
  await (await e.emergencyWithdrawToken(lp.target, recipient.address, 50n)).wait();
  await (await e.emergencyWithdrawToken(token.target, recipient.address, 25n)).wait();
  assert.equal(await token.balanceOf(recipient.address), 25n);
  assert.equal(await e.reservedETH(), ethBudget);
  assert.equal(await e.reservedLP(), lpBudget);
  const reject = await deploy(owner, 'RejectETH');
  await (await e.publishRoot(1, await e.leaf(1, reject.target, ethBudget, lpBudget))).wait();
  await protectedFunds();
  await (await e.pay(1, reject.target, ethBudget, lpBudget, [])).wait();
  assert.equal(await e.deferredETH(reject.target), ethBudget);
  assert.equal(await lp.balanceOf(reject.target), lpBudget);
  await assert.rejects(e.emergencyWithdrawETH.staticCall(recipient.address, 1n), /available/);
  const before = await p.getBalance(recipient.address);
  await (await reject.withdraw(e.target, recipient.address)).wait();
  assert.equal(await p.getBalance(recipient.address), before + ethBudget);
  assert.equal(await e.reservedETH(), 0n);
  assert.equal(await e.reservedLP(), 0n);
});

test('token rescue supports no-return tokens, rejects false returns and checks access', async (t) => {
  const { owner, keeper, recipient, token, e } = await fixture(t);
  await (await token.mint(e.target, 100)).wait();
  await assert.rejects(
    e.connect(keeper).emergencyWithdrawToken.staticCall(token.target, recipient.address, 1),
    /owner/,
  );
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(ZeroAddress, recipient.address, 1),
    /asset/,
  );
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(token.target, ZeroAddress, 1),
    /recipient/,
  );
  await assert.rejects(e.emergencyWithdrawToken.staticCall(token.target, e.target, 1), /recipient/);
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(token.target, recipient.address, 0),
    /available/,
  );
  await (await e.setPaused(false)).wait();
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(token.target, recipient.address, 1),
    /pause first/,
  );
  await (await e.setPaused(true)).wait();
  const noReturn = await deploy(owner, 'NoReturnToken');
  await (await noReturn.mint(e.target, 100)).wait();
  await (await e.emergencyWithdrawToken(noReturn.target, recipient.address, 100)).wait();
  assert.equal(await noReturn.balanceOf(recipient.address), 100n);
  const falseReturn = await deploy(owner, 'FalseReturnToken');
  await assert.rejects(
    e.emergencyWithdrawToken.staticCall(falseReturn.target, recipient.address, 100),
    /transfer/,
  );
});

test('recovery cannot reenter even when the receiver owns the engine', async (t) => {
  const { p, owner, e, fund } = await fixture(t);
  const receiver = await deploy(owner, 'RecoveryReceiver');
  await (await receiver.configure(e.target)).wait();
  await (await e.transferOwnership(receiver.target)).wait();
  await (await receiver.accept()).wait();
  await fund(100n);
  await (await receiver.recover(60n)).wait();
  assert.equal(await receiver.reentered(), false);
  assert.equal(await p.getBalance(receiver.target), 60n);
  assert.equal(await e.availableETH(), 40n);
  await assert.rejects(e.emergencyWithdrawETH.staticCall(owner.address, 40n), /owner/);
});

test('legacy recovery sequence returns the recorded deposit and resumes after a lost process receipt', async (t) => {
  const { p, owner, recipient, arb, e, bind, fund } = await fixture(t);
  await bind();
  const amount = parseEther('0.0034');
  await fund(amount);
  const journal = {
    engine: e.target,
    owner: owner.address,
    recipient: recipient.address,
    amount: String(amount),
  };
  const getSnapshot = async () => ({
    snapshot: (await arb.arbBlockNumber()) - 1n,
    deadline: (await p.getBlock('latest')).timestamp + 120,
  });
  // The recovery orchestration is shared; native legacy opcode behavior is checked
  // separately on Robinhood and the real-state fork, not asserted by this fixture.
  const before = await p.getBalance(recipient.address);
  const original = e.process;
  const lostReceipt = new Proxy(e, {
    get(target, property) {
      if (property !== 'process') return Reflect.get(target, property);
      const send = async (...args) => {
        const tx = await original(...args);
        await tx.wait();
        throw Error('simulated lost process receipt');
      };
      send.staticCall = (...args) => original.staticCall(...args);
      return send;
    },
  });
  let saves = 0;
  await assert.rejects(
    finishLegacyRecovery(lostReceipt, journal, getSnapshot, async () => {
      saves++;
    }),
    /lost process receipt/,
  );
  assert.equal(await e.epochCount(), 1n);
  assert.equal(await e.reservedETH(), amount);
  await finishLegacyRecovery(e, journal, getSnapshot, async () => {
    saves++;
  });
  assert.equal(await p.getBalance(recipient.address), before + amount);
  assert.equal(await e.paused(), true);
  assert.equal(await e.epochCount(), 1n);
  assert.equal(await e.reservedETH(), 0n);
  assert.equal(await e.availableETH(), 0n);
  assert.equal(journal.complete, true);
  assert(saves >= 2);
  await finishLegacyRecovery(e, journal, getSnapshot, async () => {});
  assert.equal(await p.getBalance(recipient.address), before + amount);
  await assert.rejects(
    finishLegacyRecovery(e, { ...journal, recipient: owner.address }, getSnapshot, async () => {}),
    /Unexpected root/,
  );
  await assert.rejects(
    finishLegacyRecovery(
      e,
      { ...journal, amount: String(amount + 1n) },
      getSnapshot,
      async () => {},
    ),
    /does not match/,
  );
});
