# Architecture (to be mentioned in README)

```
 RPC (Base) ──► Indexer ──────► Postgres ◄──── API (Fastify)
   (viem)      allocation       snapshots       /vaults/:a/report
      │        events →         markets         /vaults/:a/peak
      │        snapshot at      checkpoints
      │        that block
      └──► Chain readers ──► Oracle decoder ──► Analysis (pure)
           vault V2 → adapter   fixed | chainlink |   assumptions, breakpoints,
           → V1 vault → markets metaoracle | unknown  frozen-for
```

## Components
- **Config**: one RPC URL, tracked V2 vaults (fixed list), confirmation depth, backfill days, path to the feed and token registry.
- **Chain readers**: at a given block, read the vault's adapters, follow a `MorphoVaultV1Adapter` one level into its V1 vault (withdraw queue and positions), and return the vault's assets per market. Calls are batched with Multicall3. Any block can be read, so the same code serves "now" and "at an event block".
- **Oracle decoder**: per market oracle, classify as `fixed` (no feed), `chainlink` (`MorphoChainlinkOracleV2` immutables), `metaoracle` (primary, backup, threshold, timelocks, current state) or `unknown`. Market parameters are immutable, so a market row is written once; the MetaOracle state, which changes, is read at every snapshot block.
- **Registry** (`registry/*.json`, versioned in the repo, extended by PR): feed address → priced asset, `market` or `exchange_rate`, deviation threshold, heartbeat; token → symbol, USD peg, assets it is the same as (WETH = ETH). A feed or token missing from the registry gives `unknown`, never a guess.
- **Analysis** (pure functions): lender-side assumptions, the two breakpoints, the frozen-for window. No I/O, so it is unit-tested on fixtures.
- **Indexer**: `getLogs` on the V2 vault and its V1 vault for allocation events, in chunks, up to `head − confirmationDepth`. For each event block, it takes a snapshot of the vault at that block. A checkpoint (last block + hash) allows resume; a parent-hash mismatch triggers a rollback of the last blocks.
- **Postgres**: `checkpoints`, `markets` (collateral, oracle, LLTV, assumption), `snapshots` (vault, block, block hash, timestamp, total assets, the `/report` payload), `snapshot_positions` (snapshot, market, assets, MetaOracle state). Postgres because the data is relational (vault → market → oracle → assumption), amounts are exact big integers, and the peak is a plain SQL aggregate.
- **API**: two read endpoints (`report`, `peak`). Every response carries `block` and `asOf`; `unknown` markets are listed apart from the numbers.

## Failure paths
- RPC errors and rate limits: retry with exponential backoff (viem), at most 3 requests in flight, `getLogs` in chunks of 10,000 blocks, resume from the checkpoint. A failed indexer pass is logged and retried on the next tick. A revert is told apart from an outage (`null` vs `RpcUnavailableError`), so an outage never looks like "no such getter".
- Reorg: compare the stored hash with the chain at the checkpoint, delete snapshots after the common ancestor, re-index. Only blocks older than the confirmation depth are indexed, which makes this rare.
- Replaying a range is idempotent (unique `(vault, block)` for snapshots). The checkpoint moves only after a pass has written its snapshots.
- Reverts and unknown oracles: the market is returned as `unknown` with the reason, and the rest of the report is still served.
- RPC down: `/report` reads live at the latest block and answers 503 `RPC_UNAVAILABLE`; old data is never served as current.

## Testing
- Decoder on the real USDe/USDC MetaOracle and the cbBTC/USDC Chainlink oracle (fixtures from Base).
- Analysis: breakpoints (LLTV 91.5% gives 8.5% and ~6.1%), assumption derivation, frozen-for per class.
- Indexer: idempotent replay, resume, rollback on a hash mismatch (RPC mocked).
- Peak: SQL query on seeded snapshots (Postgres, in a throwaway schema).

## Run locally
See `README.md`.
