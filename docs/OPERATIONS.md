# Operations and integration gates

## Before mainnet funds

- Verify the Robinhood chain ID (4663), actual Forge native-ETH quote registration, hook/vault/PoolManager wiring, router deployment bytecode and five/six-field router dialect. Local mocks do not prove compatibility with live contracts.
- On a Robinhood fork, deploy the engine, launch through the real Forge manager using it as recipient, bind, trade, collect, simulate/process through the real V4 router and V2 Router02, inspect ETH/token/LP balance deltas, publish an epoch, and distribute.
- Exercise the first V2 deposit and later deposits. Existing V2 reserves may diverge from the V4 price. Keeper rejects large divergence; do not solve this by disabling min-outs. First mint must exceed V2's permanently locked minimum liquidity (normally 1,000 raw LP units).
- Confirm V2 price initialization is economically acceptable. The engine buys approximately half of liquidity ETH on V4, then adds both assets. It is not an optimal one-sided liquidity solver. Unused native ETH remains available; unused tokens are reused by a later liquidity deposit. Token dust has no admin rescue.
- Confirm native reward delivery, rejected ETH deferral, holder proof verification, duplicate retry, and LP redemption through the actual V2 router. Confirm output price-impact and min-out guards under adverse conditions.
- Review owner, keeper and publisher roles. Keeper supplies min-outs and is trusted for execution quality; the contract checks nonzero minimums but does not enforce an independent TWAP oracle. A compromised keeper can execute poor trades. Use limited round amounts; owner can pause processing.
- Review holder exclusions, supply reconciliation, snapshot RPC retention, publisher trust and point-in-time eligibility before enabling automatic publication.

## Keeper behavior

Polling only. A single worker writes `data/worker.lock`; do not run concurrent workers sharing a signer. Processing is at least ten minutes apart on-chain, with optional longer cadence. A round is capped by `MAX_PROCESS_ETH`; normal ETH dividends and LP liabilities cannot be recycled as new utility revenue.

Each signed transaction is stored before broadcast in `data/pending.json`. On restart the worker checks its receipt and confirmations or rebroadcasts the exact same signed bytes. It never creates a new processing transaction while one is pending. Dry-run never broadcasts, including recovery transactions. An externally replaced transaction/nonce conflict requires operator reconciliation. Do not delete its journal just because a receipt is slow.

Payouts take priority over new processing and run in batches of up to 50 holders (25 default). A zero-budget epoch needs no root. Nonzero distributions wait until the processing transaction is confirmed. Epoch publication is manual by default; optional automatic mode explicitly delegates holder-weight trust to the publisher key.

Budget floors leave small epoch dust reserved. There is no expiration or owner reclaim. Configuration changes affect future processing rounds, not existing epoch budgets or roots. Pause stops new processing; collection and published payouts remain usable.

## Persistence and recovery

Back up `data/` with the contract addresses and deployment blocks. Never serve this directory directly: it contains signed transaction journals. The HTTP server only serves sanitized status and public epoch manifests. Store private keys in local service environment or a secret manager, never Git or frontend assets.

On restart after a crash, verify no old process is running before removing the stale worker lock. For a holder checkpoint reorg, stop all writes, preserve manifests/journals, inspect the chain, and rebuild `holders.json` from the original deployment block. Published allocations cannot be rewritten. An epoch whose snapshot is no longer canonical stops automation and requires incident review.

PM2 example: `pm2 start ecosystem.config.cjs`. Keeper automatic restart is disabled so a stale lock or configuration failure cannot create a restart storm. Put the dashboard behind your HTTPS reverse proxy. Default bind is loopback. Do not expose its RPC through a generic public proxy.

## Validation scope

Local tests use a deterministic simulated EVM and mocks, covering authorization, binding, allocation totals, native claims, dead-address transfers, LP ownership split, reserve protection, immutable roots, Merkle proof parity, duplicate payouts, ETH deferral, batch replay and slippage failure. They do not validate real-chain router behavior, market conditions, reorg finality guarantees or infrastructure bytecode. Independent contract review and a real-chain fork test remain launch gates.

Ganache is a development-only test dependency with bundled legacy dependencies; never expose a Ganache RPC to untrusted networks or install it in production. Build artifacts first, then use `npm ci --omit=dev` for runtime services. Solidity compiler is pinned to 0.8.26 with Shanghai EVM output for runtime compatibility.
