# Robinhood clock and recovery validation — 2026-09-23

Fixture: Mamoa token `0x60Ac34AB80d2528a4C22Beb6E055C8810a7F9378`, engine `0x32B6AfdC7B3D4eeFEEEc19Da193fA227337246F0`, chain 4663. Resolved through the Forge production-i launch indexer and verified by the engine's own getters. These checks did not broadcast any mainnet transaction.

## Passed

- `npm test`: 14 tests on Anvil, including distinct opcode/L2 clocks, canonical epoch metadata, current/future/stale/zero snapshots, the 256-block boundary, missing precompile behavior, full utility lifecycle, owner-only paused ETH/token recovery, reserve/deferred protection, reentrancy, nonstandard tokens and recovery retry after a lost receipt.
- Original deployed bytecode, native read-only calls: at Robinhood block 70,799,700 (parent height 26,042,558), a 1-wei round with L2 snapshot 70,799,680 reverted with `snapshot`. The same call with parent snapshot 26,042,557 succeeded. This isolates the old clock mismatch without changing live state.
- Original deployed bytecode, full-balance read-only call: at observed L2 head 70,802,537, simulated `process` for **3,693,069,306,930,689 wei (0.003693069306930689 ETH)** with a state override setting the allocation to 100% ETH rewards and a recent parent-clock snapshot. The call succeeded. Only allocation slot 8 was overridden; no code replacement or live write. This verifies the legacy recovery processing step, not execution of the entire live retirement sequence.
- Candidate bytecode, **native Robinhood** state-override simulation: `test/fork/native-process.mjs` succeeded against the actual engine storage, real Forge hook/vault, V4 router and V2 router, and native ArbSys. The keeper built the 0.001 ETH plan with its normal price-impact and slippage checks. Snapshot: 70,805,779. No router or precompile mocks were used. The exact arguments and infrastructure are in [the native report](validation/robinhood-native-2026-09-23.json).
- Solidity 0.8.26, optimizer 200, via-IR, Shanghai; candidate runtime 12,095 bytes, below EIP-170. Formatting, JavaScript syntax and whitespace checks passed.

## Scope

Native `eth_call` discards its writes, so a successful call does not prove persistent multi-round behavior, production holder eligibility or actual payment receipts. The independent fork gate is `npm run test:fork`; its report is generated in `artifacts/robinhood-fork-report.json`. Anvil's two-method ArbSys adapter is explicitly disclosed in that gate; native ArbSys is checked separately against the upstream chain. An archive-capable RPC is required. The official RPC returned HTTP 405 in this environment, and PublicNode rejected pinned archive requests without a personal token; dRPC was also tried.

The contract source change requires a new deployment. Fork-only replacement at the old address is a testing technique, not a mainnet upgrade mechanism. The old launch's immutable utility-recipient configuration may require a new test launch to use the replacement engine. Legacy recovery deliberately retires the original engine and keeps its publisher/keeper assigned to its owner; see [the procedure](OPERATIONS.md#original-test-engine-recovery).
