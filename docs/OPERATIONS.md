# Operations and integration gates

## Before mainnet funds

- Verify the Robinhood chain ID (4663), actual Forge native-ETH quote registration, hook/vault/PoolManager wiring, router deployment bytecode and five/six-field router dialect. Local mocks do not prove compatibility with live contracts.
- On a Robinhood fork, deploy the engine, launch through the real Forge manager using it as recipient, bind, trade, collect, simulate/process through the real V4 router and V2 Router02, inspect ETH/token/LP balance deltas, publish an epoch, and distribute.
- Exercise the first V2 deposit and later deposits. Existing V2 reserves may diverge from the V4 price. Keeper rejects large divergence; do not solve this by disabling min-outs. First mint must exceed V2's permanently locked minimum liquidity (normally 1,000 raw LP units).
- Confirm V2 price initialization is economically acceptable. The engine buys approximately half of liquidity ETH on V4, then adds both assets. It is not an optimal one-sided liquidity solver. Unused native ETH remains available; unused tokens are reused by a later liquidity deposit or recovered by the owner while paused.
- Confirm native reward delivery, rejected ETH deferral, holder proof verification, duplicate retry, and LP redemption through the actual V2 router. Confirm output price-impact and min-out guards under adverse conditions.
- Review owner, keeper and publisher roles. Keeper supplies min-outs and is trusted for execution quality; the contract checks nonzero minimums but does not enforce an independent TWAP oracle. A compromised keeper can execute poor trades. Use limited round amounts; owner can pause processing.
- Review holder exclusions, supply reconciliation, snapshot RPC retention, publisher trust and point-in-time eligibility before enabling automatic publication.

## Keeper behavior

Polling only. A single worker writes `data/worker.lock`; do not run concurrent workers sharing a signer. Processing is at least ten minutes apart on-chain, with optional longer cadence. A round is capped by `MAX_PROCESS_ETH`; normal ETH dividends and LP liabilities cannot be recycled as new utility revenue.

Each signed transaction is stored before broadcast in `data/pending.json`. On restart the worker checks its receipt and confirmations or rebroadcasts the exact same signed bytes. It never creates a new processing transaction while one is pending. Dry-run never broadcasts, including recovery transactions. An externally replaced transaction/nonce conflict requires operator reconciliation. Do not delete its journal just because a receipt is slow.

Payouts take priority over new processing and run in batches of up to 50 holders (25 default). A zero-budget epoch needs no root. Nonzero distributions wait until the processing transaction is confirmed. Epoch publication is manual by default; optional automatic mode explicitly delegates holder-weight trust to the publisher key.

Budget floors leave small epoch dust reserved. There is no expiration or owner reclaim. Configuration changes affect future processing rounds, not existing epoch budgets or roots. Pause stops new processing; collection and published payouts remain usable.

## Persistence and recovery

### New engine recovery

Stop the keeper, then execute `setPaused(true)` as owner. `emergencyWithdrawETH(to, amount)` is capped at `balance - reservedETH`. `emergencyWithdrawToken(asset, to, amount)` protects `reservedLP` when the asset is the engine's LP pair. Both reject zero/self recipients and zero/excess amounts, use the reentrancy guard and emit `EmergencyWithdrawal`. They work before binding without invoking ArbSys, the hook or a router. Rejected transfers revert atomically. Token recovery accepts standard and no-return ERC20 transfers.

CLI: `npm run admin -- recovery-status`, `npm run admin -- pause`, then `npm run admin -- recover-eth YOUR_WALLET all`. For token dust: `npm run admin -- recover-token TOKEN YOUR_WALLET all`. Default is simulation; set `ADMIN_BROADCAST=true` with the owner's local key to send. Existing holder budgets (including unpublished roots), rounding dust and deferred ETH cannot be swept. Proof payouts and deferred withdrawals continue while paused.

### Original test engine recovery

Changing source code does not change deployed immutable bytecode. The original engine has no withdrawal/upgrade function, but its owner can use its existing reward pathway to recover an **unallocated personal test deposit**:

1. Stop the normal keeper. Check `ENGINE_ADDRESS`, `RPC_URL`, `CHAIN_ID=4663` and `DATA_DIR` point to the old test engine. Keep its data directory; do not delete journals.
2. Run `npm run recover:legacy`. It prints the exact engine, recipient and amount without broadcasting. `RECOVERY_RECIPIENT` defaults to the current owner. It refuses a fresh recovery if any epochs or holder reserves already exist.
3. With the owner key stored locally in `OWNER_PRIVATE_KEY`, run `npm run recover:legacy -- --broadcast` only after reviewing the printed recipient and amount. It pauses, assigns owner as keeper/publisher, sets allocations to `0/10000/0/0`, processes one ETH-only recovery epoch using the original contract's **parent block clock**, pauses again, publishes a single-recipient Merkle root and pays it. It performs no swaps or liquidity deposits.
4. If interrupted, run the same command with the same configuration. `data/legacy-recovery.json` pins identity/recipient/amount; the script reconciles epoch 1 and the on-chain paid flag. It refuses mismatched roots, budgets or additional epochs. A recipient contract that rejects ETH must call `withdrawDeferred(to)` itself.

This deliberately retires a test engine; leave it paused and do not restart its normal snapshot keeper. It is not for reclaiming holder entitlements. Future fees or deposits arriving after the recorded recovery amount are not automatically swept. A new engine cannot automatically take the old launch's utility-recipient registration: verify whether that launch can be retargeted; otherwise use a new test launch configured with the new engine from the start. Use a fresh `DATA_DIR` for the replacement so old transactions/manifests cannot be replayed.

Back up `data/` with the contract addresses and deployment blocks. Never serve this directory directly: it contains signed transaction journals. The HTTP server only serves sanitized status and public epoch manifests. Store private keys in local service environment or a secret manager, never Git or frontend assets.

On restart after a crash, verify no old process is running before removing the stale worker lock. For a holder checkpoint reorg, stop all writes, preserve manifests/journals, inspect the chain, and rebuild `holders.json` from the original deployment block. Published allocations cannot be rewritten. An epoch whose snapshot is no longer canonical stops automation and requires incident review.

PM2 example: `pm2 start ecosystem.config.cjs`. Keeper automatic restart is disabled so a stale lock or configuration failure cannot create a restart storm. Put the dashboard behind your HTTPS reverse proxy. Default bind is loopback. Do not expose its RPC through a generic public proxy.

## Validation scope

`npm test` uses Anvil and mocks, with an ArbSys adapter whose L2 height is deliberately one million blocks above the opcode height. This catches regressions to `block.number` in validation or epoch creation, and to `blockhash` in snapshot recording. Tests cover the 256-block boundary, missing/zero precompile responses, recovery before binding, owner/pause enforcement, reserved/deferred ETH and LP protection, failed sends, nonstandard ERC20 transfers, reentrancy and interrupted legacy recovery, as well as the original lifecycle/indexer checks. Local mocks do not prove live router compatibility.

`npm run test:fork` requires an archive-capable `FORK_RPC_URL` (or `RPC_URL`), `FORK_ENGINE_ADDRESS` (or `ENGINE_ADDRESS`) pointing to an unused bound test engine, and the actual `V4_QUOTER_ADDRESS`. Optional `FORK_BLOCK_NUMBER` pins a repeatable block and `FORK_PROCESS_ETH` changes the default 0.001 ETH fork round. No private key is needed; only the loopback fork is mutated. The upstream RPC is read-only. The test uses native upstream ArbSys checks plus a clearly identified local clock adapter because Anvil is not Nitro. All other infrastructure is real fork state. It records whether a V2 pair already existed, and uses a single-recipient test leaf rather than claiming to validate production holder eligibility. Full launch-manager deployment/binding and LP redemption remain separate integration gates.

ArbSys's canonical L2 height/hash are used for every process snapshot and `createdBlock`; the keeper/indexer's RPC block numbers therefore use the same domain. Current/future and older-than-256 snapshots are rejected before calling `arbBlockHash`. Missing precompile calls fail closed, with no fallback to the parent clock. Deployment preflight compares ArbSys to a pinned RPC header. Sources: [ArbSys interface](https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbSys.sol), [Arbitrum Solidity differences](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/solidity-support).

Ganache has been removed. Anvil is a development-only dependency; keep its RPC on loopback. Build artifacts first, then use `npm ci --omit=dev` for runtime services. Solidity compiler is pinned to 0.8.26 with Shanghai EVM output for runtime compatibility.
