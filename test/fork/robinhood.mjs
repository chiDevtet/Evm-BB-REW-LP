// Real-state integration gate. No signer or write RPC is ever attached to upstream.
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Contract,
  JsonRpcProvider,
  FetchRequest,
  ZeroAddress,
  parseEther,
  toQuantity,
  getAddress,
} from 'ethers';
import { checkArbSys } from '../../scripts/chain-check.mjs';
import { startAnvil, installArbSys, artifact, deploy } from '../helpers/anvil.mjs';
import { finishLegacyRecovery } from '../../scripts/legacy-recovery-core.mjs';

const report = {
  status: 'FAILED',
  mode: 'Robinhood real-state Anvil fork',
  stages: [],
  rounds: [],
};
const stage = (message) => {
  report.stages.push(message);
  console.log(message);
};
const reportPath = 'artifacts/robinhood-fork-report.json';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-fork-'));
// Never mix fork state or public test manifests into the live keeper directory.
process.env.DATA_DIR = temp;
const request = new FetchRequest(
  process.env.FORK_RPC_URL || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
);
request.timeout = 20000;
const upstream = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
let fork;
try {
  const block = process.env.FORK_BLOCK_NUMBER ? Number(process.env.FORK_BLOCK_NUMBER) : 'latest';
  if (block !== 'latest' && (!Number.isSafeInteger(block) || block < 1))
    throw Error('Invalid FORK_BLOCK_NUMBER');
  const clock = await checkArbSys(upstream, block);
  report.block = clock.head.number;
  report.blockHash = clock.head.hash;
  stage('native upstream ArbSys matches canonical RPC height and hash');
  const address = getAddress(process.env.FORK_ENGINE_ADDRESS || process.env.ENGINE_ADDRESS || '');
  if (!process.env.V4_QUOTER_ADDRESS)
    throw Error('V4_QUOTER_ADDRESS is required for real minimum-output quotes');
  if ((await upstream.getCode(address, clock.head.number)) === '0x')
    throw Error('FORK_ENGINE_ADDRESS has no code');
  report.engine = address;
  fork = await startAnvil([
    '--fork-url',
    request.url,
    '--fork-block-number',
    String(clock.head.number),
    '--timeout',
    '20000',
    '--retries',
    '1',
  ]);
  const p = fork.provider;
  const deployer = await p.getSigner(0);
  const e = new Contract(address, artifact('UtilityEngine').abi, p);
  const ownerAddress = await e.owner(),
    keeperAddress = await e.keeper();
  const treasury = await e.treasury(),
    hook = await e.hook(),
    router = await e.router(),
    v2Address = await e.v2();
  const tokenAddress = await e.token(),
    id = await e.poolId();
  if (tokenAddress === ZeroAddress) throw Error('Fork fixture must be a bound test engine');
  if (
    (await e.epochCount()) !== 0n ||
    (await e.reservedETH()) !== 0n ||
    (await e.reservedLP()) !== 0n
  )
    throw Error('Use the unused test engine: fixture requires zero existing epochs/reserves');
  report.originalBalance = String(await p.getBalance(address));
  report.infrastructure = {
    token: tokenAddress,
    hook,
    vault: await e.vault(),
    router,
    v2: v2Address,
    sixField: await e.sixField(),
  };
  for (const contract of [
    tokenAddress,
    hook,
    await e.vault(),
    router,
    v2Address,
    process.env.V4_QUOTER_ADDRESS,
  ])
    assert.notEqual(await p.getCode(contract), '0x', `Missing real infrastructure ${contract}`);

  // Anvil is an EVM, not Nitro. Verify the real precompile above, then install ONLY
  // its two clock methods locally using the fork's canonical headers. Do not mock routers.
  await installArbSys(p, deployer, 0n);
  stage('installed test-only ArbSys adapter over real fork headers (Anvil has no ArbOS)');
  for (const account of new Set([ownerAddress, keeperAddress])) {
    await p.send('anvil_impersonateAccount', [account]);
    await p.send('anvil_setBalance', [account, toQuantity(parseEther('10'))]);
  }
  const owner = await p.getSigner(ownerAddress),
    keeper = await p.getSigner(keeperAddress);
  // Exercise the actual original deployed bytecode, then restore the fork exactly.
  const legacySnapshot = await p.send('evm_snapshot', []);
  const legacyAmount = await e.availableETH();
  assert(legacyAmount > 0n, 'Original engine has no unallocated test deposit');
  const legacyBefore = await p.getBalance(deployer.address);
  const legacyJournal = {
    engine: address,
    owner: ownerAddress,
    recipient: deployer.address,
    amount: String(legacyAmount),
  };
  await finishLegacyRecovery(
    e.connect(owner),
    legacyJournal,
    async () => {
      // Anvil's unmodified NUMBER/BLOCKHASH use its fork height. The independent
      // upstream eth_call below/operations evidence verifies Nitro's parent clock.
      const h = await p.getBlock('latest');
      return { snapshot: h.number - 1, deadline: h.timestamp + 120 };
    },
    async () => {},
  );
  assert.equal(await p.getBalance(deployer.address), legacyBefore + legacyAmount);
  assert.equal(await e.reservedETH(), 0n);
  assert.equal(await e.paused(), true);
  report.legacyRecovered = String(legacyAmount);
  stage(
    'original deployed bytecode returns unallocated deposit through the retirement reward path',
  );
  assert.equal(await p.send('evm_revert', [legacySnapshot]), true);
  const candidate = await deploy(deployer, 'UtilityEngine', [
    ownerAddress,
    keeperAddress,
    treasury,
    hook,
    router,
    v2Address,
    await e.sixField(),
  ]);
  // Fresh deployment recovery must work while unbound.
  await (
    await deployer.sendTransaction({ to: candidate.target, value: parseEther('0.0034') })
  ).wait();
  await (
    await candidate.connect(owner).emergencyWithdrawETH(deployer.address, parseEther('0.0034'))
  ).wait();
  assert.equal(await p.getBalance(candidate.target), 0n);
  stage('fresh unbound engine recovers 0.0034 fork ETH');

  // Local-only replacement preserves the real launch's registered utility recipient.
  // This patch adds no storage fields. This is NOT an upgrade path on mainnet.
  await p.send('anvil_setCode', [address, await p.getCode(candidate.target)]);
  assert.equal(await e.owner(), ownerAddress);
  assert.equal(await e.keeper(), keeperAddress);
  assert.equal(await e.token(), tokenAddress);
  assert.equal(await e.poolId(), id);
  stage('installed candidate runtime at old engine address on the local fork only');
  await (await e.connect(owner).setAllocations(4000, 3000, 3000, 2000)).wait();
  await (await e.connect(owner).setPublisher(ownerAddress)).wait();
  await (await e.connect(owner).setPaused(false)).wait();
  const token = new Contract(
    tokenAddress,
    ['function balanceOf(address) view returns(uint256)'],
    p,
  );
  const v2 = new Contract(
    v2Address,
    ['function factory() view returns(address)', 'function WETH() view returns(address)'],
    p,
  );
  const factory = new Contract(
    await v2.factory(),
    ['function getPair(address,address) view returns(address)'],
    p,
  );
  report.initialPair = await factory.getPair(tokenAddress, await v2.WETH());
  process.env.MAX_PROCESS_ETH = process.env.FORK_PROCESS_ETH || '0.001';
  process.env.MIN_PROCESS_ETH = process.env.MAX_PROCESS_ETH;
  const amount = parseEther(process.env.MAX_PROCESS_ETH);
  if (amount <= 0n) throw Error('FORK_PROCESS_ETH must be positive');
  const { plan } = await import('../../keeper/plan.mjs');
  for (let i = 1; i <= 2; i++) {
    await (await deployer.sendTransaction({ to: address, value: amount })).wait();
    const last = Number(await e.lastProcessedAt());
    const head = await p.getBlock('latest');
    if (head.timestamp < last + 600) {
      await p.send('evm_setNextBlockTimestamp', [last + 601]);
      await p.send('evm_mine', []);
    }
    const planned = await plan({ provider: p, engine: e });
    assert(planned, 'No process plan');
    const dead = await e.DEAD(),
      burnedBefore = await token.balanceOf(dead);
    const reservedBefore = await e.reservedETH();
    await e.connect(keeper).process.staticCall(...planned.args);
    const receipt = await (await e.connect(keeper).process(...planned.args)).wait();
    const epoch = await e.epochs(i);
    assert.equal(epoch.createdBlock, BigInt(receipt.blockNumber));
    assert.equal(epoch.snapshotHash, (await p.getBlock(Number(epoch.snapshotBlock))).hash);
    assert.equal(epoch.snapshotBlock, BigInt(planned.snapshot));
    assert((await token.balanceOf(dead)) > burnedBefore, 'Real V4 burn did not deliver tokens');
    assert(epoch.lpBudget > 0n && epoch.ethBudget > 0n, 'Missing holder budgets');
    assert.equal(await e.reservedETH(), reservedBefore + epoch.ethBudget);
    const lp = new Contract(
      await e.pair(),
      ['function balanceOf(address) view returns(uint256)'],
      p,
    );
    assert.equal(await e.reservedLP(), await lp.balanceOf(address));
    // Real V4 trades should accrue real utility fees, redeemable through the real vault.
    const pending = await e.pendingFees();
    assert(
      pending > 0n,
      'No live utility fees accrued; check the fixture launch fee configuration',
    );
    const availableBefore = await e.availableETH();
    await (await e.connect(owner).collect()).wait();
    assert.equal(await e.pendingFees(), 0n);
    assert.equal(await e.availableETH(), availableBefore + pending);
    await (await e.connect(owner).setPaused(true)).wait();
    if (deployer.address.toLowerCase() !== ownerAddress.toLowerCase())
      await assert.rejects(
        e.connect(deployer).emergencyWithdrawETH.staticCall(deployer.address, 1n),
      );
    await assert.rejects(
      e
        .connect(owner)
        .emergencyWithdrawETH.staticCall(deployer.address, (await e.availableETH()) + 1n),
    );
    await assert.rejects(
      e.connect(owner).emergencyWithdrawToken.staticCall(lp.target, deployer.address, 1n),
    );
    // A fixture leaf tests proof payout/accounting, not a production holder manifest.
    const root = await e.leaf(i, deployer.address, epoch.ethBudget, epoch.lpBudget);
    await (await e.connect(owner).publishRoot(i, root)).wait();
    const ethBefore = await p.getBalance(deployer.address),
      lpBefore = await lp.balanceOf(deployer.address);
    await (
      await e.connect(owner).pay(i, deployer.address, epoch.ethBudget, epoch.lpBudget, [])
    ).wait();
    assert.equal(await p.getBalance(deployer.address), ethBefore + epoch.ethBudget);
    assert.equal(await lp.balanceOf(deployer.address), lpBefore + epoch.lpBudget);
    assert.equal(await e.reservedETH(), 0n);
    assert.equal(await e.reservedLP(), 0n);
    report.rounds.push({
      epoch: i,
      transactionHash: receipt.hash,
      snapshotBlock: planned.snapshot,
      snapshotHash: epoch.snapshotHash,
      lp: String(epoch.lpBudget),
      eth: String(epoch.ethBudget),
      collected: String(pending),
    });
    await (await e.connect(owner).setPaused(false)).wait();
  }
  await (await e.connect(owner).setPaused(true)).wait();
  const remaining = await e.availableETH();
  if (remaining > 0n)
    await (await e.connect(owner).emergencyWithdrawETH(deployer.address, remaining)).wait();
  const dust = await token.balanceOf(address);
  if (dust > 0n)
    await (
      await e.connect(owner).emergencyWithdrawToken(tokenAddress, deployer.address, dust)
    ).wait();
  assert.equal(await p.getBalance(address), 0n);
  assert.equal(await token.balanceOf(address), 0n);
  stage(
    'two real-router rounds, vault collection, proof payouts, reserve protection and final recovery',
  );
  report.status = 'PASSED';
} catch (error) {
  // Avoid printing an authenticated RPC URL or local environment in error output.
  report.error = (error.shortMessage || error.message).split(request.url).join('[RPC_URL]');
  console.error('Robinhood fork gate FAILED:', report.error);
  process.exitCode = 1;
} finally {
  await fork?.close();
  upstream.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${reportPath}`);
}
