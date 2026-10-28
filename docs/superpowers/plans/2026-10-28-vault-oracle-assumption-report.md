# Vault Oracle Assumption Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript service that, for tracked Morpho V2 vaults on Base, reports the oracle assumptions each vault's money relies on (exposure, breakpoints, how long the oracle can stay frozen) and the 30-day peak exposure.

**Architecture:** Chain readers (viem) decode vault positions and market oracles at any block. Pure analysis functions turn them into a report. An event indexer takes a snapshot at each allocation-event block into Postgres, which serves `/peak`. Fastify exposes the API. See `ARCHITECTURE.md`.

**Tech Stack:** Node 22, TypeScript (strict), viem, Fastify, zod, `pg` with plain SQL migrations, vitest, docker compose.

**Spec:** `docs/superpowers/specs/2026-10-28-vault-oracle-assumption-report-design.md` (read it and `AGENTS.md` first; `ARCHITECTURE.md` for the shape).

## Global Constraints

- Time box 4h: 3h40 of work + 20 min buffer. Cut order if late: `/health` → `/peak` → rollback logic (keep confirmation depth) → backfill beyond 7 days → tracked vaults down to 3.
- Onchain data only over RPC (`RPC_URL`, one Infura Base URL). Never the Morpho API. Read-only: no transactions.
- Amounts are `bigint` in code, strings in JSON. Never `number` for token amounts.
- Every API response carries `block` and `asOf` (`asOf` = block timestamp). Unknown or stale data is flagged (`unknown`, `stale: true` with `staleSeconds`), never hidden or guessed. Follow the spec's "API conventions" exactly: `*Pct` in percent, decimal-string amounts with a top-level `asset`, `seconds` + `human` durations, fixed enums, `assumptionId` as the stable key, error shape `{ error: { code, message } }`.
- Lender side only: assumptions on the collateral. No risk score, no `threatensLender` field.
- Registry (`registry/*.json`) decides what a feed means. Missing entry → `unknown`.
- `drain = 1 − LLTV`; `badDebt = 1 − LLTV × LIF`; `LIF = min(1.15, 1 / (0.3 × LLTV + 0.7))`.
- RPC limits (Infura free): `getLogs` ≤ 10,000 blocks per call; concurrency 3 to 4; use Multicall3 and batches; backoff on 429. `CONFIRMATIONS` defaults to 20, `BACKFILL_DAYS` to 7.
- Adapters: `MorphoMarketV1` is read with `marketIdsLength()`, `marketIds(uint256)`, `expectedSupplyAssets(bytes32)`; `MorphoVaultV1Adapter` with `morphoVaultV1()` and `realAssets()`, then one level into the V1 vault (`withdrawQueueLength()`, `withdrawQueue(uint256)`, Morpho `position` and `market`). Any other adapter is reported as unknown.
- V1 vault events to index: `ReallocateSupply`, `ReallocateWithdraw`, ERC4626 `Deposit`, `Withdraw`. V2 vault events: `Allocate`, `Deallocate`, `ForceDeallocate`.
- Do not commit unless the user asks (`AGENTS.md`). Each task ends by staging its files and stopping.

## Review Focus

Inputs and conditions the spec implies but does not test; each has a test in the owning task.

1. A vault whose `totalAssets` exceeds the sum of market positions (idle assets, rounding): the report shows an `idle` share and shares add up to ~100%. (Task 5)
2. A market with no collateral (idle market, collateral = zero address): skipped, never decoded, never an error. (Task 4)
3. An oracle that reverts or has an unexpected shape: that market becomes `unknown` with a reason; the rest of the report is still served. (Task 3)
4. RPC down or rate limited: retry with backoff, then `/report` falls back to the last snapshot with `stale: true`; with no snapshot, a clear 503. (Task 8)
5. Invalid address, address in a different case, vault not in the tracked list, or `block` before the vault existed: 400 / 404 with a message, addresses normalized to checksum. (Task 8)

---

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  docker-compose.yml  Dockerfile
registry/feeds.json  registry/tokens.json
src/config.ts                 env parsing (zod)
src/types.ts                  shared types (see Task 1)
src/chain/reader.ts           ChainReader interface + viem implementation (retry, batching)
src/chain/oracleDecoder.ts    decodeOracle
src/chain/vaultReader.ts      readVault
src/chain/marketReader.ts     readMarket
src/analysis/breakpoints.ts   breakpoints
src/analysis/registry.ts      loadRegistry
src/analysis/assumptions.ts   deriveAssumption
src/analysis/frozenFor.ts     frozenFor
src/analysis/report.ts        buildReport
src/db/migrations/001_init.sql  src/db/pool.ts  src/db/repo.ts
src/indexer/events.ts         event topics, coalesce
src/indexer/indexer.ts        indexRange, runIndexer, reorg handling
src/api/server.ts             buildServer
src/main.ts                   wiring
test/**                       unit tests, fixtures/ (real Base data), live tests (skip without RPC_URL)
```

## Shared types (`src/types.ts`, defined in Task 1, used everywhere)

```ts
export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export interface Position { marketId: Hex; assets: bigint }
export interface MarketInfo { id: Hex; loan: Address; collateral: Address; oracle: Address; lltv: bigint /* 1e18 */ }
export type ReasonCode = 'FEED_NOT_IN_REGISTRY' | 'TOKEN_NOT_IN_REGISTRY' | 'FIXED_PRICE_UNPEGGED' | 'ORACLE_REVERTED' | 'ORACLE_UNSUPPORTED' | 'UNKNOWN_ADAPTER';
export type DecodedOracle =
  | { class: 'fixed'; address: Address }
  | { class: 'chainlink'; address: Address; feeds: Address[]; baseVault?: Address }
  | { class: 'metaoracle'; address: Address; primary: DecodedOracle; backup: DecodedOracle;
      deviationThreshold: bigint /* 1e18 */; deviation: bigint /* 1e18, getDeviation() */;
      challengeSeconds: number; healingSeconds: number; challengeExpiresAt?: number; healingExpiresAt?: number /* unix s, absent when 0 */;
      state: 'primary' | 'challenged' | 'backup' | 'healing' }
  | { class: 'unknown'; address: Address; reasonCode: ReasonCode; reason: string };
export type FrozenFor =
  | { kind: 'unbounded' }
  | { kind: 'timelock'; seconds: number; state: string; expiresAt?: number }
  | { kind: 'feed_heartbeat'; deviationPct: number; heartbeatSeconds: number }
  | { kind: 'unknown'; reasonCode: ReasonCode };
export interface ChainReader {
  call(to: Address, data: Hex, block?: bigint): Promise<Hex | null>; // null on revert
  blockNumber(): Promise<bigint>;
  block(n: bigint): Promise<{ number: bigint; hash: Hex; timestamp: number }>;
  logs(p: { addresses: Address[]; topics0: Hex[]; from: bigint; to: bigint }): Promise<{ address: Address; blockNumber: bigint; txHash: Hex; logIndex: number }[]>;
}
```

---

### Task 1: Scaffold, config, types

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `Dockerfile`, `src/types.ts`, `src/config.ts`, `test/config.test.ts`.

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): Config` where `Config = { rpcUrl: string; databaseUrl: string; vaults: Address[]; confirmations: number; backfillDays: number; port: number }`; throws a readable error listing every invalid variable. Types from the Shared types block.

- [ ] **Step 1:** Write `test/config.test.ts`: valid env parses (`VAULTS` comma-separated, normalized to checksum); missing `RPC_URL` throws an error mentioning `RPC_URL`; `CONFIRMATIONS` defaults to 20 and `BACKFILL_DAYS` to 7.
- [ ] **Step 2:** `npm i viem fastify zod pg` and dev deps `typescript vitest tsx @types/node @types/pg`; add scripts `dev` (tsx src/main.ts), `test`, `typecheck` (tsc --noEmit). Run `npm test`: FAIL (no `loadConfig`).
- [ ] **Step 3:** Implement `loadConfig` in `src/config.ts` with zod. Add `docker-compose.yml` with a `postgres:16` service (`DATABASE_URL` default `postgres://app:app@localhost:5432/oracle`) and the service entry (built in Task 9).
- [ ] **Step 4:** `npm test && npm run typecheck`: PASS.
- [ ] **Step 5:** `git add` the new files; stop for the user to commit.

### Task 2: Breakpoints

**Files:** Create `src/analysis/breakpoints.ts`, `test/analysis/breakpoints.test.ts`.

**Interfaces:**
- Produces: `breakpoints(lltv: bigint): { drainPct: number; badDebtPct: number }` (lltv scaled 1e18; percentages rounded to 1 decimal).

- [ ] **Step 1:** Tests: `breakpoints(915000000000000000n)` → `{ drainPct: 8.5, badDebtPct: 6.1 }`; `625000000000000000n` → `{ drainPct: 37.5, badDebtPct: 35.7 }` (LIF = 1/(0.3×0.625+0.7) = 1.1268, 1 − 0.625×1.1268 = 0.2958, so assert `badDebtPct: 29.6`); `300000000000000000n` → LIF would be 1.2658, capped at 1.15, so `badDebtPct: 65.5` and `drainPct: 70`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement with bigint-safe conversion to number only at the end (percentages are not token amounts).
- [ ] **Step 4:** Run: PASS. **Step 5:** stage; stop.

### Task 3: Oracle decoder

**Files:** Create `src/chain/oracleDecoder.ts`, `test/chain/oracleDecoder.test.ts`, `test/fixtures/oracles.json`, `test/chain/oracleDecoder.live.test.ts`.

**Interfaces:**
- Consumes: `ChainReader`, `DecodedOracle`.
- Produces: `decodeOracle(reader: ChainReader, address: Address, block?: bigint): Promise<DecodedOracle>`.

- [ ] **Step 1:** Fixtures: record the real `eth_call` responses (at one block) for the USDe/USDC MetaOracle `0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47` (primary `0xf243538bc89634b0abb5686a5b72e21282a54695`, backup `0x995aed0fa3dbe02fa1efa50f65ea57dc0b3dcf6a`) and the cbBTC/USDC oracle `0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9` (feed `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F`). Build a `fakeReader(fixture)` helper.
- [ ] **Step 2:** Tests: USDe oracle → `class 'metaoracle'`, `primary.class 'fixed'`, `backup.class 'chainlink'` with the USDe/USD feed, `deviationThreshold 5000000000000000n`, `deviation` equal to the fixture's `getDeviation()` (266070774826103n), `challengeSeconds 57600`, `healingSeconds 86400`, `state 'primary'`, `challengeExpiresAt` and `healingExpiresAt` absent. A fixture with `isChallenged` true and a non-zero `challengeExpiresAt()` → `state 'challenged'` with `challengeExpiresAt` set. cbBTC oracle → `chainlink` with one feed. An address whose calls all revert → `{ class: 'unknown', reasonCode: 'ORACLE_REVERTED', reason }` (Review Focus 3). A chainlink oracle whose feed calls revert → still `chainlink` (feeds are addresses, not read here).
- [ ] **Step 3:** Run: FAIL.
- [ ] **Step 4:** Implement: try `BASE_FEED_1()`; if it answers, read `BASE_FEED_1/2`, `BASE_VAULT`, treat zero addresses as absent; `fixed` when no feed and no vault. Else try `primaryOracle()` (MetaOracle, one nesting level), read `backupOracle`, `deviationThreshold`, `challengeTimelockDuration`, `healingTimelockDuration`, and state from `isChallenged`/`isBackup`/`isHealing`. Else `unknown`.
- [ ] **Step 5:** Live test (`describe.skipIf(!process.env.RPC_URL)`) decodes the same two oracles on Base. Run unit tests: PASS.
- [ ] **Step 6:** stage; stop.

### Task 4: Market reader, vault reader

**Files:** Create `src/chain/marketReader.ts`, `src/chain/vaultReader.ts`, `test/chain/vaultReader.test.ts`, `test/chain/vaultReader.live.test.ts`.

**Interfaces:**
- Consumes: `ChainReader`.
- Produces: `readMarket(reader, marketId: Hex, block?: bigint): Promise<MarketInfo | null>` (Morpho `idToMarketParams`, address `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`); `readVault(reader, vault: Address, block?: bigint): Promise<{ name: string; asset: { address: Address; symbol: string; decimals: number }; totalAssets: bigint; positions: Position[]; unknownAdapters: Address[] }>`; `readToken(reader, token: Address): Promise<{ symbol: string; decimals: number }>` (ERC20 `symbol()` and `decimals()`; some tokens return `bytes32` symbols, handle both).

- [ ] **Step 1:** Tests with a fake reader: a vault with one `MorphoMarketV1` adapter (2 markets) → positions from `expectedSupplyAssets`, zero positions dropped; a vault with a `MorphoVaultV1Adapter` → V1 market positions scaled by `realAssets / v1 positions total` (assert the sum equals `realAssets` within 1 unit); an unrecognized adapter → listed in `unknownAdapters`, others still read. `readMarket` for a market whose collateral is the zero address returns it with that collateral (the caller skips it; Review Focus 2).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. Use Multicall3 inside the viem-backed reader (Task 8 wires it), not here: this task only issues `call`s through the interface.
- [ ] **Step 4:** Live test on the demo vault `0xbeeff2490FEffa212faC2f6553682C219E6a8845`: 6 positions, sum within 1,000 units of `totalAssets`, the USDe market `0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354` holds roughly 76% (between 70% and 80%). Run unit tests: PASS.
- [ ] **Step 5:** stage; stop.

### Task 5: Registry, assumptions, frozen-for, report

**Files:** Create `registry/feeds.json`, `registry/tokens.json`, `src/analysis/registry.ts`, `assumptions.ts`, `frozenFor.ts`, `report.ts`, tests under `test/analysis/`.

**Interfaces:**
- Consumes: `DecodedOracle`, `Position`, `MarketInfo`, `breakpoints`, `decodeOracle`, `readVault`, `readMarket`.
- Produces:
  - `Registry = { feeds: Map<Address, { description: string; base: string; quote: string; type: 'market' | 'exchange_rate'; deviationPct?: number; heartbeatSeconds?: number }>; tokens: Map<Address, { symbol: string; underlying: string; peg?: 'USD'; trivialWith?: string[] }> }` and `loadRegistry(dir: string): Registry` (zod-validated, addresses normalized).
  - `deriveAssumption(collateral: Address, oracle: DecodedOracle, registry: Registry): { kind: 'assumption'; id: string; text: string } | { kind: 'none' } | { kind: 'unknown'; reasonCode: ReasonCode; reason: string }`. `id` is lowercase `<symbol>:<priced asset>` (`usde:usd`, `cbbtc:btc`) or `<symbol>:exchange-rate`.
  - `frozenFor(oracle: DecodedOracle, registry: Registry): FrozenFor`.
  - `buildReport(deps: { reader: ChainReader; registry: Registry }, vault: Address, block?: bigint): Promise<Report>` with `Report` exactly the shape of the spec's `/report` JSON (names, `asset`, formatted `totalAssets`, `exposures[]` sorted by share with per-market detail and worst-case `breakpoints`, `idle`, `unknown` with `reasonCode`). `frozenFor` also returns `human`; for a `challenged` MetaOracle `seconds` is the remaining time and `expiresAt` is set; for `backup` or `healing` it is the backup oracle's `frozenFor`.

Rules to implement (decided here): the priced asset of a chainlink oracle is the first feed's `base` when it has one feed with `quote USD`, or the first feed's `base` when two feeds chain (`f1.quote === f2.base`, `f2.quote USD`). Assumption text is `${symbol} = ${priced}` when `symbol !== priced` and `priced` is not in the token's `trivialWith`; `${symbol} = protocol exchange rate` if any feed is `exchange_rate`; for a `fixed` oracle, `${symbol} = 1 USD` if the token has `peg: 'USD'`, else `unknown`. For a MetaOracle, derive from `primary`. Feed or token missing from the registry → `unknown`. `frozenFor`: fixed → `unbounded`; chainlink with an `exchange_rate` feed → `unbounded`; chainlink with market feeds → `feed_heartbeat` using the largest `heartbeatSeconds` and `deviationPct` (missing → `unknown`); MetaOracle with a `fixed` primary → `timelock` with `minSeconds = challengeSeconds` and the `state`; MetaOracle with another primary → `frozenFor(primary)`.

- [ ] **Step 1:** Fill `registry/*.json` for the feeds and tokens reached by the five tracked vaults (scripted lookup from `readVault` + `decodeOracle`; set `deviationPct` and `heartbeatSeconds` from Chainlink's published data, leave them out when not confirmed). Include the mGLO feed as `type: 'market'` with no thresholds, so it shows as `unknown`.
- [ ] **Step 2:** Tests: `deriveAssumption` for cbBTC + BTC/USD → `cbBTC = BTC` with id `cbbtc:btc`; USDe + MetaOracle(primary fixed) → `USDe = 1 USD` with id `usde:usd`; WETH + ETH/USD → `none`; wstETH + exchange-rate feed → `wstETH = protocol exchange rate`; collateral not in registry → `unknown`. `frozenFor`: USDe MetaOracle → `{ kind: 'timelock', seconds: 57600, state: 'primary' }`; challenged with 3h left → `seconds` 10800 and `expiresAt`; state `backup` → the backup feed's `frozenFor`; fixed → `unbounded`; feed without thresholds → `unknown`. `buildReport` with a fake reader: shares sum to ~100% including `idle` when `totalAssets` exceeds positions (Review Focus 1); two markets with the same assumption are summed; an `unknown` market is listed apart with its reason and excluded from `exposures`; a zero-collateral market is skipped; two markets with the same assumption and different LLTV (0.86 and 0.915 fixtures) → the exposure's `breakpoints` are the lowest of both and each market keeps its own; exposures + `idle` + `unknown` shares sum to 100 ±0.1; an unknown market carries a `reasonCode`.
- [ ] **Step 3:** Run: FAIL. **Step 4:** Implement. **Step 5:** Run: PASS. Live test (skipped without `RPC_URL`): the demo vault report has an exposure `usde:usd` between 70% and 80% with `frozenFor.seconds 57600`.
- [ ] **Step 6:** stage; stop.

### Task 6: Viem-backed ChainReader and `/report` (vertical slice, no DB)

**Files:** Create `src/chain/reader.ts`, `src/api/server.ts`, `src/main.ts`, `test/api/report.test.ts`, `test/api/vaults.test.ts`.

**Interfaces:**
- Produces: `createViemReader(rpcUrl: string, opts?: { concurrency?: number; maxRetries?: number }): ChainReader` (concurrency 3, retry with exponential backoff on 429 and network errors, `call` returns null on revert); `buildServer(deps: { reader: ChainReader; registry: Registry; vaults: Address[]; repo?: Repo }): FastifyInstance`.

- [ ] **Step 1:** Tests with Fastify `inject` and a fake reader: `GET /vaults/:address/report` returns 200 with `block` and `asOf`; unknown vault → 404; invalid address → 400; lowercase address accepted (Review Focus 5). `GET /vaults` returns the configured vaults with `address`, `name` (read from the vault's `name()`), `asset` (`symbol`, `decimals`), `lastSnapshotBlock` (null when there is no repo or no snapshot), plus `block` and `asOf`. Error responses use `{ error: { code, message } }` with `INVALID_ADDRESS` (400) and `VAULT_NOT_TRACKED` (404); a successful `/report` has `asset`, a decimal-string `totalAssets` and `staleSeconds: null`.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement `createViemReader` (batch via Multicall3 where `call`s are issued in the same tick if simple; otherwise plain concurrency-limited calls) and the route; wire `main.ts`.
- [ ] **Step 4:** Run: PASS. Manual: `npm run dev`, `curl localhost:3000/vaults/0xbeeff2490FEffa212faC2f6553682C219E6a8845/report` returns the USDe exposure. **This is the first demo-able state: stop and show it to the user.**
- [ ] **Step 5:** stage; stop.

### Task 7: Database layer and peak query

**Files:** Create `src/db/migrations/001_init.sql`, `src/db/pool.ts`, `src/db/repo.ts`, `test/db/repo.test.ts`.

**Interfaces:**
- Produces: `Repo` with `upsertMarket(m: { id; collateral; oracle; lltv; assumptionId: string | null; assumption: string | null; oracleClass: string }): Promise<void>`; `insertSnapshot(s: { vault; block: bigint; blockHash: Hex; ts: Date; totalAssets: bigint; positions: { marketId: Hex; assets: bigint; metaState?: unknown }[] }): Promise<void>` (idempotent on `(vault, block)`); `getCheckpoint(vault)` / `setCheckpoint(vault, block, hash)`; `snapshotHashes(vault, limit)`; `deleteSnapshotsAfter(vault, block)`; `peaks(vault, days): Promise<{ coverage: { from: Date | null; snapshots: number; windowComplete: boolean }; peaks: { assumptionId: string; assumption: string; currentSharePct: number; peakSharePct: number; peakBlock: bigint; peakAt: Date }[] }>`; `latestSnapshot(vault)`.

- [ ] **Step 1:** Tests (skip unless `DATABASE_URL`): insert twice the same `(vault, block)` → one row; seed 3 snapshots with different USDe shares → `peaks` returns the max, its block, the current share from the latest, and `coverage.snapshots === 3`; `deleteSnapshotsAfter` removes later rows only; amounts round-trip exactly (use a value above 2^53).
- [ ] **Step 2:** Run: FAIL. **Step 3:** Write the migration (tables per the spec's schema plus `block_hash` on `snapshots`; `NUMERIC` for amounts) and the repo; migrations run at startup in order.
- [ ] **Step 4:** Run with `docker compose up -d postgres`: PASS. **Step 5:** stage; stop.

### Task 8: Indexer, rollback, remaining endpoints

**Files:** Create `src/indexer/events.ts`, `src/indexer/indexer.ts`, extend `src/api/server.ts`, tests `test/indexer/*.test.ts`, `test/api/*.test.ts`.

**Interfaces:**
- Produces: `coalesceBlocks(blocks: { number: bigint; timestamp: number }[], windowSeconds: number): bigint[]` (at most one block per window, always keeps the first and last of the input); `indexRange(deps: { reader; repo; registry }, vault: Address, from: bigint, to: bigint): Promise<{ snapshots: number }>`; `runIndexer(deps, cfg, signal: AbortSignal): Promise<void>`. API: `GET /vaults/:address/peak?days=`, `GET /markets/:id/oracle`, `GET /health`; `/report` falls back to `repo.latestSnapshot` with `stale: true` when the reader fails.

- [ ] **Step 1:** Tests with a fake chain and an in-memory or real repo: (a) `coalesceBlocks` keeps one block per window; (b) `indexRange` over a range with 3 event blocks writes 3 snapshots, and running it twice writes no duplicates (idempotent); (c) `runIndexer` resumes from the checkpoint after a restart without re-reading earlier blocks; (d) a checkpoint hash that no longer matches the chain triggers rollback: snapshots after the last matching `block_hash` are deleted and indexing restarts from there; (e) only blocks ≤ `head − confirmations` are indexed; (f) V1 vault events (including `Deposit`/`Withdraw`) trigger snapshots for the V2 vault. API: `/peak` returns `coverage` with `windowComplete` false when the first snapshot is younger than the window, and keeps an assumption now at 0%; `/health` reports lag per vault; with the reader throwing, `/report` returns the last snapshot with `stale: true` and `staleSeconds` set, and `RPC_UNAVAILABLE` (503) when none exists (Review Focus 4); `/markets/:id/oracle` returns `state`, `deviationPct`, `deviationThresholdPct` and, when challenged, `challenge.expiresAt`; unknown market or zero-collateral market → `MARKET_NOT_FOUND` (404); invalid address → `INVALID_ADDRESS`, untracked vault → `VAULT_NOT_TRACKED`, unavailable block → `BLOCK_NOT_AVAILABLE`; a `block` before the vault existed → 404 with a message.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement: `getLogs` in 10,000-block chunks, resolve the V1 vault addresses from the adapters at start, backfill from `head − BACKFILL_DAYS × 43200` when no checkpoint, snapshot via `buildReport` data at each coalesced block (window 600s), checkpoint and snapshots written in one transaction.
- [ ] **Step 4:** Run: PASS. Manual: run against the demo vault with `BACKFILL_DAYS=1`; `/peak` returns a non-empty `peaks` array.
- [ ] **Step 5:** stage; stop.

### Task 9: Packaging, README, final run

**Files:** Create `Dockerfile`, finish `docker-compose.yml`, `README.md`, `scripts/demo.sh`; check `BusinessCase.md`.

- [ ] **Step 1:** `docker compose up` boots Postgres and the service from a clean clone with only `RPC_URL` set; the service runs migrations and starts the indexer.
- [ ] **Step 2:** `README.md`: what it is (link `BusinessCase.md`), the architecture section (from `ARCHITECTURE.md`), run instructions, env variables, endpoint list with `curl` examples, limits. `scripts/demo.sh` curls `/report`, `/peak`, `/markets/:id/oracle` for the demo vault.
- [ ] **Step 3:** Run `npm run typecheck && npm test`, then the demo script against the demo vault; compare the output with the numbers in `BusinessCase.md` (the 39% example must be replaced by the measured 76%) and fix the memo.
- [ ] **Step 4:** stage; stop for the user's final commit.

---

## Self-Review

- **Spec coverage:** endpoints (`report`, `peak`, `oracle`, `health`) → Tasks 6, 8; computation (exposure, assumption, breakpoints, frozen-for) → Tasks 2, 5; indexer (sources, loop, backfill, coalescing, rollback) → Task 8; schema → Task 7; adapters → Task 4; registry → Task 5; failure paths → Tasks 3, 8; time budget and cut order → Global Constraints.
- **Type consistency:** `DecodedOracle`, `Position`, `MarketInfo`, `ChainReader`, `FrozenFor` are defined once in Shared types and used by name in every task.
- **Known gaps to settle during Task 5:** Chainlink thresholds for the mGLO feed and any feed not confirmed from Chainlink's published data stay `unknown`; `/peak` is a lower bound (documented by `coverage`).
