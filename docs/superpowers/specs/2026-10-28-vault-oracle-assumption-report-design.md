# Vault Oracle Assumption Report — Design

Time box: **4 hours.** See `BusinessCase.md` for the why and `ARCHITECTURE.md` for the shape. This spec is what to build, in what order, and what to cut.

## Decisions

- Lender side only. Only assumptions on the **collateral** are reported ("USDe = $1"). Assumptions on the quote side ("USDC = $1") hurt the borrower, not the lender, so they are not exposed. No `threatensLender` field. Edge case lost: a loan token that collapses.
- Fixed list of 3 to 5 Base V2 vaults. Demo vault: Steakhouse High Yield USDC Edition `0xbeeff2490FEffa212faC2f6553682C219E6a8845` (463 M$, 76.3% in the USDe/USDC MetaOracle market, 19.8% mGLO). Others to track: Grove x Steakhouse USDC `0xbeef0786…e7c7`, Steakhouse Prime USDC `0xbeef0e08…73C9`, Gauntlet USDC Prime `0x050cE30b…56f0`, Clearstar cbAssets `0x91C056B6…3a3c`. No auto-discovery. A short list keeps the feed registry small.
- V2 vaults plus **one level** of V1 vault behind a `MorphoVaultV1Adapter` (real V2 vaults use it). Standalone V1 vaults are out.
- Event indexer, not polling. No `/changes` endpoint. `/peak` is in.
- No risk score. Facts only.
- Stack: Node 22, TypeScript, viem, Fastify, zod, `pg` with plain SQL migrations, vitest, docker compose.

## Endpoints

All responses carry `block`, `asOf`. Amounts are strings (6 decimals for USDC).

### `GET /vaults/:address/report?block=`
Defaults to the latest block.
```json
{
  "vault": "0x01af…12AF", "block": 52000000, "asOf": "2026-10-28T12:00:00Z",
  "totalAssets": "1073645805825", "stale": false,
  "exposures": [
    { "assumption": "USDe = 1 USD", "oracleClass": "metaoracle", "sharePct": 38.8,
      "assets": "416321500000",
      "frozenFor": { "kind": "timelock", "minSeconds": 57600 },
      "breakpoints": { "drainPct": 8.5, "badDebtPct": 6.1 },
      "markets": ["0x54cf…7354"] }
  ],
  "unknown": { "sharePct": 0.8, "markets": [{ "id": "0x4440…", "reason": "feed not in registry" }] }
}
```
`frozenFor.kind`: `unbounded` (fixed price, or exchange-rate feed against a market depeg), `timelock` (MetaOracle), `feed_heartbeat` (market feed, from registry), `unknown`.

### `GET /vaults/:address/peak?days=30`
Peak share per assumption across stored snapshots in the window.
```json
{ "vault": "0x01af…12AF", "windowDays": 30, "coverage": { "from": "2026-10-21T00:00:00Z", "snapshots": 14 },
  "peaks": [ { "assumption": "USDe = 1 USD", "currentSharePct": 38.8,
               "peakSharePct": 52.3, "peakBlock": 51700000, "peakAt": "2026-10-19T08:30:00Z" } ] }
```
`coverage` is mandatory: the peak is a lower bound sampled at allocation events (interest accrual between events is ignored).

### `GET /markets/:id/oracle`
Decoded oracle: class, feeds with registry data, MetaOracle parameters and state, lender-side assumptions, LLTV and breakpoints.

### `GET /health`
RPC reachable, latest block, indexer lag per vault, DB.

## Computation

- **Exposure**: vault assets per market at block B. Via a `MorphoVaultV1Adapter`: each V1 market's assets × (adapter `realAssets` / V1 `totalAssets`). Idle assets are reported as `idle`. Assumptions are summed by text.
- **Assumption** (collateral side): from the registry, compare the collateral token with the asset the feed prices. Same asset: no assumption. Different (cbBTC priced by BTC/USD): "cbBTC = BTC". No feed (fixed price) on a USD-pegged token: "X = 1 USD". Anything not in the registry: `unknown`.
- **Breakpoints**: `drain = 1 − LLTV`, `badDebt = 1 − LLTV × LIF`, `LIF = min(1.15, 1 / (0.3 × LLTV + 0.7))`. At 91.5%: 8.5% and ~6.1%.
- **Frozen-for**: fixed price = unbounded; MetaOracle on primary-fixed = `challengeTimelockDuration` as a minimum, plus the current state (`challenged`, `backup`); `chainlink` market feed = heartbeat and deviation from the registry; `exchange_rate` feed = unbounded against a market depeg.

## Indexer

- Sources: the V2 vault (`Allocate`, `Deallocate`, `ForceDeallocate`; also emitted on user deposits and withdrawals, checked in `VaultV2.sol`) and its V1 vault (`ReallocateSupply`, `ReallocateWithdraw` **and** the ERC4626 `Deposit` / `Withdraw`). `Reallocate*` is only emitted by `reallocate()`: on the Steakhouse V1 vault over ~200k blocks, 110 of 526 transactions moving its Morpho position had a `Reallocate*` event and the other 416 were user deposits or withdrawals. Event names checked against the Morpho repos.
- Cost control: coalesce events so a vault gets at most one snapshot per time window (about 10 min) and per block. That vault had ~425 user events in ~4.6 days.
- Loop: `getLogs` in chunks up to `head − CONFIRMATIONS`; for each distinct block with an event, read the vault state at that block and write `snapshots` and `snapshot_positions`; then advance the checkpoint, all in one transaction.
- Backfill: if no checkpoint, start at `head − BACKFILL_DAYS` (default 7; 30 for the demo). A first snapshot is taken at the start block.
- MetaOracle state is read at each snapshot block. State changes with no vault event in between are not captured: documented limit.

## Schema (sketch)

`vaults(address pk, name, v1_address)` · `checkpoints(vault pk, last_block, last_hash)` · `markets(id pk, loan, collateral, oracle, lltv, decoded jsonb, class, assumption)` · `snapshots(id pk, vault, block, ts, total_assets, unique(vault, block))` · `snapshot_positions(snapshot_id, market_id, assets, meta_state jsonb)` · `events(tx_hash, log_index, vault, block, kind, unique(tx_hash, log_index))`.

## Time budget (4h target: 3h40 of work, 20 min buffer)

| Block | Time |
|---|---|
| Scaffold: TS, Fastify, viem, Postgres, docker compose, migrations | 0:15 |
| Chain readers: V2 adapters → V1 vault → markets, Multicall3 | 0:35 |
| Oracle decoder + registry (only the feeds reached by the tracked vaults) | 0:35 |
| Analysis: assumptions, breakpoints, frozen-for | 0:20 |
| Indexer: logs, snapshots, checkpoint, rollback | 0:45 |
| API: report, oracle, peak, health | 0:25 |
| Tests (decoder fixtures, analysis, indexer, peak SQL) | 0:30 |
| README, BusinessCase check, final run on real vaults | 0:15 |

Total 3:40. **Cut order if late**: `/health` → `/peak` → rollback logic (keep the confirmation depth) → backfill beyond 7 days → number of tracked vaults (down to 3).

## Risks and assumptions to verify early (first 30 min)

- Two adapter types exist and both must be read. `MorphoMarketV1` (direct, used by the largest vaults): `marketIdsLength()`, `marketIds(index)`, `expectedSupplyAssets(marketId)`, verified on the demo vault. `MorphoVaultV1Adapter` (smaller vaults): `morphoVaultV1()`, `realAssets()`. Anything else is reported as an unknown adapter.
- **RPC (measured, Infura free plan, Base)**: one URL does everything. Historical `eth_call` works at least 90 days back, Multicall3 exists at those blocks, JSON-RPC batches of 50 work, and `eth_getLogs` accepts up to 10,000 blocks per call (50,000 returns -32602). Rate limiting is stricter than it looks: 7 of 40 sequential `eth_call` returned 429 at about 3.6 requests/second, and one `getLogs` of 100 blocks got a 429, so the real limit (requests/second or daily credits) is not known. Design: a single `RPC_URL`, `getLogs` in 10,000-block chunks, concurrency of 3 to 4, Multicall3 and JSON-RPC batches to cut request count, backoff on 429. QuickNode free was rejected (`getLogs` limited to 5 blocks). Public endpoints are not reliable for `getLogs` (`mainnet.base.org` 429, `1rpc.io` 50 blocks, `drpc` free 10k, `publicnode` worked).
- Chainlink deviation and heartbeat for each reached feed must be filled by hand from Chainlink's data; a missing value gives `unknown`, not a guess.
- The cbBTC/USD feed `0x64c9…848F` returns `BTC / USD` but its contract type is unverified.
- Interest accrual is ignored between snapshots, so exposures are slightly off between events.
