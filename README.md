# Forge Utility • ETH / buyback / rewards / V2 LP

Standalone, single-launch utility receiver for a Forge V4 **native ETH** launch on Robinhood Chain (4663), plus a polling keeper, holder indexer, and responsive dashboard.

**Status: Robinhood ArbSys block-clock fix and paused owner recovery implemented. Not independently audited. Run the real-state fork gate against your configured test engine before funding a replacement.** No private keys are included.

## What it does

1. A new Forge utility launch names `UtilityEngine` as its sole utility recipient (recipient weight 10,000).
2. The engine pulls utility bucket 3 from the Forge claim vault, or accepts ETH already delivered by the authorized sweeper.
3. A bounded processing round buys tokens on the original V4 pool. Its buyback portion is sent to `0x000000000000000000000000000000000000dEaD`.
4. The liquidity portion supplies tokens + ETH to a separate Uniswap V2 token/WETH pair. Router02 wraps ETH. A configurable portion of new LP tokens goes directly to treasury.
5. Remaining LP and ETH rewards are reserved for a snapshot of eligible token holders. A publisher commits a Merkle root; the keeper sends proofs in batches directly to holders. Anyone can submit a valid proof, with no ability to change its recipient.

V2 trades pay V2 trading fees, **not Forge's V4 utility fees**. Original V4 launch liquidity is unchanged. Sending tokens to the dead address reduces circulating supply but does not reduce the token's `totalSupply()`.

## Quick start

Requires Node 22+ and npm. From this repository:

```bash
npm ci
npm test
cp .env.example .env
npm start
```

The dashboard is available at `http://127.0.0.1:3000`. Without an engine address it shows a clearly labeled predeployment state, not fabricated statistics. With configuration it reads live totals, allocations, reserves and recent epochs. It is read-only; administration stays with your wallet/multisig.

```bash
npm run keeper -- --once  # DRY_RUN=true by default
npm run keeper           # polling loop, no WebSocket dependency
```

`npm run compile` generates ABI/bytecode and reproducible Solidity compiler input in `artifacts/`. Keep the artifacts when installing production-only dependencies. Test mocks are never deployed by the deployment script.

## Configuration

Copy `.env.example`. Use your current deployed Forge hook, its compatible Universal Router and V4 quoter. `V4_SIX_FIELD` must match that router's swap parameter dialect. Native ETH is `address(0)` in V4; the engine rejects a WETH-quoted or stock-quoted Forge launch.

Official Uniswap V2 deployment documentation lists Robinhood:

| Contract | Address                                      |
| -------- | -------------------------------------------- |
| Factory  | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` |
| Router02 | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |

Source: https://developers.uniswap.org/docs/protocols/v2/deployments (checked September 20, 2026). The deploy script checks code presence, router factory identity and WETH code via RPC. These checks are not a bytecode audit. Verify infrastructure and router dialect against the actual chain before broadcast.

## Deploy and connect a new launch

1. Configure owner (prefer multisig), keeper and treasury addresses, RPC and infrastructure. The utility receiver is deployed **before** the token; no predicted token address is necessary.
2. `npm run deploy` runs preflight. `npm run deploy -- --broadcast` sends a deployment using the local `DEPLOYER_PRIVATE_KEY`.
3. Set `ENGINE_ADDRESS`. On Forge create a **Utility** launch quoted in **native ETH**, with the engine as the sole utility recipient. Its weight is 100% of the utility bucket, not 100% of trading fees. Platform/creator fee shares remain Forge settings.
4. Record `TOKEN_ADDRESS`, `TOKEN_DEPLOY_BLOCK` (including the mint event) and `ENGINE_DEPLOY_BLOCK`. Bind once: `npm run admin -- bind TOKEN_ADDRESS`. Admin script prints calldata and simulates by default; use a multisig or set `ADMIN_BROADCAST=true` with the owner key locally.
5. Configure all four percentages in one call: `npm run admin -- allocations 4000 3000 3000 2000`. The first three sum to 10,000. The last is treasury's percentage of newly minted LP, independent of the ETH split. Defaults are examples, not final economics.
6. Define exclusions and minimum holdings. Exclude every pool/custody/distributor address. Zero, dead, the engine, Forge PoolManager, and the engine's V2 pair are automatically excluded. Other pools/bridges/treasury are **not** guessed; add them explicitly where desired.
7. Run dry-run, inspect planned minimum outputs, run the real-chain integration gate in `docs/OPERATIONS.md`, then unpause. `npm run admin -- unpause` is simulated unless explicitly enabled.
8. Set `DRY_RUN=false` for keeper writes. Gas comes from the keeper wallet; reserved ETH is never used for gas.

## Withdraw testing funds

New engines support owner-only recovery while paused, even before binding or if a router/precompile is broken. Unallocated ETH, token dust, and LP above the holder reserve can be recovered. Existing epoch budgets and deferred holder ETH remain protected.

```bash
npm run admin -- recovery-status
npm run admin -- pause
npm run admin -- recover-eth YOUR_WALLET all
# Token amount is in raw units, or use all for the unreserved balance:
npm run admin -- recover-token TOKEN_ADDRESS YOUR_WALLET all
```

Admin commands simulate by default. Set `ADMIN_BROADCAST=true` and the local owner key to execute, or submit the printed calldata through the owner multisig. When executing, pause must finish before withdrawal.

For the **original test engine without a withdrawal function**, stop its keeper and read [the legacy recovery procedure](docs/OPERATIONS.md#original-test-engine-recovery). `npm run recover:legacy` is read-only by default. It can retire an unused test engine via one ETH-only reward epoch; it refuses existing holder epochs/reserves. This is not an upgrade.

## Robinhood fork gate

```bash
# Use an archive-capable Robinhood RPC; no private key is used.
FORK_RPC_URL=https://YOUR_ARCHIVE_RPC \
FORK_ENGINE_ADDRESS=YOUR_OLD_BOUND_TEST_ENGINE \
V4_QUOTER_ADDRESS=YOUR_REAL_QUOTER npm run test:fork
```

The gate pins a real chain block and checks native ArbSys responses, then runs against the real deployed hook/vault, token, V4 router and V2 router. It checks legacy recovery, replacement-engine recovery, two processing rounds, fee collection, proof payouts and reserve protection. Missing configuration, archive access or any failed assertion exits nonzero; the report is `artifacts/robinhood-fork-report.json`.

Anvil does not execute ArbOS: the fork explicitly installs a test-only adapter for ArbSys's two clock methods after checking the real precompile. Candidate code is installed at the old engine address **on the local fork only** to preserve its registered utility recipient. This neither upgrades the deployed engine nor proves that an existing launch can be redirected. The initial pair status is recorded; a fixture with an existing pair only tests subsequent V2 deposits. See [operations](docs/OPERATIONS.md) for deployment and test limits.

`npm run test:native` uses the same RPC/engine/quoter settings for an additional read-only `eth_call` test: it substitutes the candidate runtime (with the actual immutable infrastructure addresses), keeps real state and **native ArbSys**, and executes the keeper's quoted round with its normal slippage limits. The fixture must already be unpaused and funded; do not change live state just to run this check. This proves one simulated round, not persistent payouts or a multi-round lifecycle. It writes `artifacts/robinhood-native-report.json`.

## Holder distributions

The indexer replays all `Transfer` logs from deployment to a confirmed block, reconciles balances to historical `totalSupply()`, and pins the block hash. It requires an RPC with historical reads and complete logs. Checkpoint reorgs stop the worker for operator review rather than silently changing allocations.

Eligibility is a **point-in-time wallet balance** at the snapshot, not time-weighted holding and not LP look-through ownership. Snapshot timing can be gamed; do not market this as continuous holding rewards. Rounding floors each allocation. Tiny residual ETH/LP stays reserved in its epoch; there is no owner sweep of holder funds.

```bash
npm run epoch -- prepare 1
# Review data/epoch-1.json; root, balances policy, excluded addresses, proof rows.
npm run epoch -- publish 1
```

The initial root publisher is the owner. Owner can assign a separate publisher with `npm run admin -- publisher ADDRESS`. Publication is a transaction, using `PUBLISHER_PRIVATE_KEY`; for a multisig call `publishRoot(epoch, root)` through the multisig instead. `AUTO_PUBLISH=true` allows the keeper service to sign publication using the separate publisher key after preparing a manifest. Default is manual review.

**Trust boundary:** the publisher can misallocate an epoch's ETH and LP by publishing an incorrect root. On-chain budgets prevent overspending, but contracts cannot independently verify historical holder weights. Keep the role with the owner/multisig or explicitly trust an isolated publisher key. Roots are immutable once published.

Keeper batch payments are idempotent. An ETH-rejecting recipient gets a deferred balance and can call `withdrawDeferred(to)` itself. LP transfers still complete. Anyone can call `pay`/`payBatch` with the published proof manifest; payouts always go to the encoded holder.

## Repository map

- `contracts/UtilityEngine.sol`: native receiver, V4 buys, V2 liquidity, allocation configuration, epoch reserves and proof payouts.
- `keeper/`: durable transaction journal, holder replay, Merkle manifests, pricing plans, keeper and read-only API.
- `web/`: responsive landing/dashboard, live data and explicit empty/error states.
- `scripts/`: reproducible compiler, deployment preflight, owner administration.
- `test/`: local EVM lifecycle tests and indexer/Merkle arithmetic tests.
- `docs/OPERATIONS.md`: deployment gates, recovery and limitations.

No mainnet contract or website is deployed by cloning, compiling, testing, or starting the dashboard.
