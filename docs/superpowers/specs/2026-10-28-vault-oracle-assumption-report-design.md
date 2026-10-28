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

### API conventions (apply to every endpoint)

- Every response carries `block` and `asOf`. `asOf` is the **timestamp of that block** (ISO 8601 UTC), not the time of the request.
- Percentages are numbers in percent, one decimal (`76.3`, `lltvPct: 91.5`). Fields end in `Pct`.
- Amounts are exact decimal strings in token units (`"463354112.1"`), with the token in a top-level `asset: { symbol, decimals }`. No dollar values: the project has no price source.
- Durations come as `seconds` plus a `human` string (`"at least 16h"`).
- Staleness: `stale: boolean` and `staleSeconds: number | null` (age of the snapshot served instead of live data).
- Shares are of the vault's `totalAssets`: exposures + `idle` + `noAssumption` + `unknown` add up to 100 (±0.1). `noAssumption` holds markets where the collateral is priced as itself (WETH by ETH/USD): no hidden bet, but still vault money.
- Fixed enums (documented here, typed in code): `oracleClass`: `fixed | chainlink | metaoracle | unknown`; `frozenFor.kind`: `unbounded | timelock | feed_heartbeat | unknown`; MetaOracle `state`: `primary | challenged | backup | healing`; `reasonCode`: `FEED_NOT_IN_REGISTRY | TOKEN_NOT_IN_REGISTRY | FIXED_PRICE_UNPEGGED | ORACLE_REVERTED | ORACLE_UNSUPPORTED | UNKNOWN_ADAPTER`.
- Errors: `{ "error": { "code": "...", "message": "..." } }` with `INVALID_ADDRESS` (400), `VAULT_NOT_TRACKED` (404), `BLOCK_NOT_AVAILABLE` (404), `MARKET_NOT_FOUND` (404), `RPC_UNAVAILABLE` (503, no snapshot to fall back on), `INVALID_PARAMETER` (400, e.g. `block=abc`), `INTERNAL_ERROR` (500, unexpected failure; the cause is logged, not returned).
- `assumptionId` is the stable key of an assumption (lowercase `<collateral symbol>:<priced asset>`, e.g. `usde:usd`, `cbbtc:btc`, `wsteth:exchange-rate`). Use it to group, diff and deduplicate; `assumption` is only the label.

### `GET /vaults`
The tracked vaults (from config), so a user doesn't need to know the addresses.
```json
{ "block": 53206000, "asOf": "2026-10-28T12:00:00Z",
  "vaults": [{ "address": "0xbeeff249…8845", "name": "Steakhouse High Yield USDC Edition",
               "asset": { "symbol": "USDC", "decimals": 6 }, "lastSnapshotBlock": 53205990 }] }
```
`name` is read from the vault (`name()`); `lastSnapshotBlock` is null before the first snapshot.

### `GET /vaults/:address/report?block=`
Defaults to the latest block.
```json
{
  "vault": "0xbeeff249…8845", "name": "Steakhouse High Yield USDC Edition",
  "block": 53206000, "asOf": "2026-10-28T12:00:00Z", "stale": false, "staleSeconds": null,
  "asset": { "symbol": "USDC", "decimals": 6 }, "totalAssets": "463354112.1",
  "exposures": [{
    "assumptionId": "usde:usd", "assumption": "USDe = 1 USD", "oracleClass": "metaoracle",
    "sharePct": 76.3, "assets": "353500000.0",
    "frozenFor": { "kind": "timelock", "seconds": 57600, "human": "at least 16h", "state": "primary" },
    "breakpoints": { "drainPct": 8.5, "badDebtPct": 6.1 },
    "markets": [{ "id": "0x54cf…7354", "collateral": "USDe", "loan": "USDC", "sharePct": 76.3,
                  "lltvPct": 91.5, "breakpoints": { "drainPct": 8.5, "badDebtPct": 6.1 } }]
  }],
  "idle": { "sharePct": 0.0 },
  "noAssumption": { "sharePct": 0.0, "markets": [] },
  "unknown": { "sharePct": 19.8, "markets": [{ "id": "0x…", "collateral": "mGLO", "loan": "USDC",
               "reasonCode": "FEED_NOT_IN_REGISTRY", "reason": "feed 0x… is not in registry/feeds.json" }] }
}
```
- Exposures are sorted by `sharePct` descending (stable order for a UI).
- An exposure's `breakpoints` is the **worst case** (lowest values) across its markets; the per-market values are underneath.
- `frozenFor.seconds` is the time before the oracle can leave its current price: the full challenge duration when the MetaOracle is on `primary`; the **remaining** time, with an `expiresAt`, when it is `challenged`. When the state is `backup` or `healing`, `frozenFor` is the one of the backup oracle.
- `frozenFor.kind`: `unbounded` (fixed price, or exchange-rate feed against a market depeg), `timelock` (MetaOracle), `feed_heartbeat` (market feed, from registry; carries `deviationPct` and `heartbeatSeconds`), `unknown` (carries `reasonCode`).

### `GET /vaults/:address/peak?days=30`
Peak share per assumption across stored snapshots in the window.
```json
{ "vault": "0xbeeff249…8845", "block": 53206000, "asOf": "2026-10-28T12:00:00Z", "windowDays": 30,
  "coverage": { "from": "2026-10-21T00:00:00Z", "snapshots": 14, "windowComplete": false },
  "peaks": [{ "assumptionId": "usde:usd", "assumption": "USDe = 1 USD", "currentSharePct": 76.3,
              "peakSharePct": 81.0, "peakBlock": 52800000, "peakAt": "2026-10-23T08:30:00Z" }] }
```
`coverage` is mandatory: the peak is a lower bound sampled at allocation events (interest accrual between events is ignored). `windowComplete` is false when the first snapshot is more recent than the requested window. An assumption seen in the window but now at 0% stays in the list.

### `GET /markets/:id/oracle`
Decoded oracle of a market, as far as the registry allows.
```json
{ "marketId": "0x54cf…7354", "block": 53206000, "asOf": "2026-10-28T12:00:00Z",
  "collateral": { "address": "0x5d3a…ef34", "symbol": "USDe" }, "loan": { "symbol": "USDC" },
  "lltvPct": 91.5, "assumptionId": "usde:usd", "assumption": "USDe = 1 USD",
  "oracle": { "address": "0xF4b1…9A47", "class": "metaoracle", "state": "primary",
    "primary": { "class": "fixed" },
    "backup": { "class": "chainlink", "feeds": [{ "address": "0x7901…e73b", "pair": "USDe / USD", "type": "market" }] },
    "deviationPct": 0.027, "deviationThresholdPct": 0.5,
    "challenge": { "seconds": 57600, "human": "16h", "expiresAt": null },
    "healing": { "seconds": 86400, "human": "24h", "expiresAt": null } },
  "frozenFor": { "kind": "timelock", "seconds": 57600, "human": "at least 16h", "state": "primary" },
  "breakpoints": { "drainPct": 8.5, "badDebtPct": 6.1 } }
```
For a `chainlink` oracle, `oracle` carries `feeds` (each with registry `pair`, `type`, `deviationPct`, `heartbeatSeconds` when known). For an `unknown` oracle, it carries `reasonCode` and `reason` only. `deviationPct` is the current gap between the primary and the backup price, to compare with `deviationThresholdPct`. A market whose collateral is the zero address returns `MARKET_NOT_FOUND`-style 404 with a message (it has no oracle).

### `GET /health`
RPC reachable, latest block, indexer lag per vault, DB.

## Computation

- **Exposure**: vault assets per market at block B. Via a `MorphoVaultV1Adapter`: each V1 market's assets × (adapter `realAssets` / V1 `totalAssets`). Idle assets are reported as `idle`. Assumptions are summed by `assumptionId`.
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
