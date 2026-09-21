import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ganache from 'ganache';
import {
  BrowserProvider,
  ContractFactory,
  Contract,
  AbiCoder,
  keccak256,
  ZeroAddress,
  parseEther,
} from 'ethers';
import { distribution } from '../keeper/merkle.mjs';
test('utility lifecycle: permissions, ETH fees, burn, LP, protected budgets, proofs and failed recipients', async () => {
  const rpc = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: 'shanghai', chainId: 4663 },
    wallet: { totalAccounts: 5 },
  });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const owner = await provider.getSigner(0),
    keeper = await provider.getSigner(1),
    treasury = await provider.getSigner(2),
    holder = await provider.getSigner(3),
    outsider = await provider.getSigner(4);
  const deploy = async (name, args = []) => {
    const a = JSON.parse(fs.readFileSync(`artifacts/${name}.json`));
    const c = await new ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  try {
    const token = await deploy('MockToken'),
      weth = await deploy('MockToken'),
      hook = await deploy('MockHook'),
      vault = await deploy('MockVault', [hook.target]),
      router = await deploy('MockRouter', [token.target]),
      v2 = await deploy('MockV2', [weth.target]);
    await (await hook.configure(vault.target, token.target, ZeroAddress, ZeroAddress)).wait();
    const e = await deploy('UtilityEngine', [
      await owner.getAddress(),
      await keeper.getAddress(),
      await treasury.getAddress(),
      hook.target,
      router.target,
      v2.target,
      true,
    ]);
    await (await hook.configure(vault.target, token.target, e.target, ZeroAddress)).wait();
    const id = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint24,int24,address)'],
        [[ZeroAddress, token.target, 0, 60, hook.target]],
      ),
    );
    await assert.rejects(e.connect(outsider).bind.staticCall(token.target, id));
    await (await hook.configure(vault.target, token.target, e.target, weth.target)).wait();
    await assert.rejects(e.bind.staticCall(token.target, id));
    await (await hook.configure(vault.target, token.target, e.target, ZeroAddress)).wait();
    await (await e.bind(token.target, id)).wait();
    await assert.rejects(e.bind.staticCall(token.target, id));
    await assert.rejects(e.setAllocations.staticCall(5000, 5000, 5000, 0));
    await assert.rejects(e.connect(keeper).setAllocations.staticCall(10000, 0, 0, 0));
    await (await owner.sendTransaction({ to: vault.target, value: parseEther('1') })).wait();
    await (await hook.accrue(id, parseEther('1'))).wait();
    await (await e.collect()).wait();
    assert.equal(await e.availableETH(), parseEther('1'));
    assert.equal(await e.pendingFees(), 0n);
    const build = async (amount) => {
      const h = await provider.getBlock('latest');
      return [amount, parseEther('540'), 1n, 1n, 1n, h.timestamp + 120, h.number - 1];
    };
    await assert.rejects(e.connect(keeper).process.staticCall(...(await build(parseEther('1')))));
    await (await e.setPaused(false)).wait();
    await assert.rejects(e.connect(outsider).process.staticCall(...(await build(parseEther('1')))));
    await (await e.connect(keeper).process(...(await build(parseEther('1'))))).wait();
    assert.equal(await e.totalBurned(), parseEther('400'));
    assert.equal(await token.balanceOf(await e.DEAD()), parseEther('400'));
    assert.equal(await e.reservedETH(), parseEther('0.3'));
    assert.equal(await e.reservedLP(), parseEther('0.12'));
    assert.equal(await e.availableETH(), 0n);
    const lp = new Contract(
      await e.pair(),
      JSON.parse(fs.readFileSync('artifacts/MockToken.json')).abi,
      provider,
    );
    assert.equal(await lp.balanceOf(await treasury.getAddress()), parseEther('0.03'));
    await assert.rejects(e.connect(keeper).process.staticCall(...(await build(parseEther('0.3')))));
    const reject = await deploy('RejectETH');
    const holderAddress = await holder.getAddress();
    const d = distribution({
      chain: 4663,
      engine: e.target,
      epoch: 1,
      balances: { [holderAddress]: '1', [reject.target]: '1' },
      ethBudget: parseEther('0.3'),
      lpBudget: parseEther('0.12'),
    });
    await assert.rejects(e.connect(outsider).publishRoot.staticCall(1, d.root));
    await (await e.publishRoot(1, d.root)).wait();
    await assert.rejects(e.publishRoot.staticCall(1, d.root));
    const r = d.rows.find((r) => r.address === holderAddress);
    assert.equal(
      await e.leaf(1, r.address, r.eth, r.lp),
      (await import('../keeper/merkle.mjs')).leaf(4663, e.target, 1, r.address, r.eth, r.lp),
    );
    await assert.rejects(e.pay.staticCall(1, r.address, BigInt(r.eth) + 1n, r.lp, r.proof));
    await (await e.connect(outsider).pay(1, r.address, r.eth, r.lp, r.proof)).wait();
    await assert.rejects(e.pay.staticCall(1, r.address, r.eth, r.lp, r.proof));
    assert.equal(await lp.balanceOf(holderAddress), parseEther('0.06'));
    const q = d.rows.find((r) => r.address === reject.target);
    await (
      await e.payBatch([
        [1, r.address, r.eth, r.lp, r.proof],
        [1, q.address, q.eth, q.lp, q.proof],
      ])
    ).wait();
    await (await e.payBatch([[1, q.address, q.eth, q.lp, q.proof]])).wait();
    assert.equal(await e.deferredETH(reject.target), parseEther('0.15'));
    assert.equal(await e.reservedETH(), parseEther('0.15'));
    assert.equal(await e.reservedLP(), 0n);
    await (await reject.withdraw(e.target, holderAddress)).wait();
    assert.equal(await e.reservedETH(), 0n);
    // Native-only binding and low-output swaps fail closed.
    await (await owner.sendTransaction({ to: e.target, value: parseEther('1') })).wait();
    await provider.send('evm_increaseTime', [601]);
    await provider.send('evm_mine', []);
    await (await router.setMultiplier(1)).wait();
    await assert.rejects(e.connect(keeper).process.staticCall(...(await build(parseEther('1')))));
    assert.equal(await e.epochCount(), 1n);
    await (await e.transferOwnership(holderAddress)).wait();
    await assert.rejects(e.connect(outsider).acceptOwnership.staticCall());
    await (await e.connect(holder).acceptOwnership()).wait();
    assert.equal(await e.owner(), holderAddress);
  } finally {
    await rpc.disconnect();
  }
});
