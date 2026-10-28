# Vault Oracle Assumption Report

For a Morpho Vault V2 on Base: which hidden bets its oracles rely on (e.g. "USDe = $1"), how much of the vault rests on each, how long the oracle can stay blind if one breaks, and the peak exposure over time.

Why this project: [BusinessCase.md](BusinessCase.md). Brief: [ASSESSEMENT.md](ASSESSEMENT.md). Design and cut order: [the spec](docs/superpowers/specs/2026-10-28-vault-oracle-assumption-report-design.md).

Example, read on-chain on the demo vault (Steakhouse High Yield USDC, 2026-10-28): 76% of the vault assumes `USDe = 1 USD`. Its oracle (a MetaOracle) can keep that price **at least 16h** after a depeg. Bad debt starts at about **6.1%** below $1. About 20% sits in markets whose feed is not in the registry and is reported as `unknown`.

## Architecture

An indexer turns the vault's allocation events into snapshots in Postgres; chain readers and a pure analysis turn a vault at any block into a report. Diagram, components and failure paths: [ARCHITECTURE.md](ARCHITECTURE.md). What a feed or token *means* is decided by the registry in [registry/](registry/README.md); anything missing is `unknown`, never a guess.

Where to start reading: `src/chain/oracleDecoder.ts` (oracle classes), `src/chain/vaultReader.ts` (vault to positions), `src/analysis/` (assumptions, frozen-for, breakpoints), `src/report.ts` (puts it together), `src/indexer/indexer.ts` (snapshots).

Formulas: `drain = 1 − LLTV`, `badDebt = 1 − LLTV × LIF`, `LIF = min(1.15, 1 / (0.3 × LLTV + 0.7))`. At LLTV 91.5%: 8.5% and about 6.1%.

## Run

Needs Docker and one Base RPC URL that serves historical `eth_call` (past blocks) and `getLogs` (ranges up to 10,000 blocks).

```bash
cp .env.example .env        # then set RPC_URL (never commit it)
docker compose up --build   # Postgres + service on http://localhost:3000
scripts/demo.sh             # calls the main endpoints for the demo vault (needs jq)
```

The first boot backfills `BACKFILL_DAYS` of history (compose default: 1 day, about 2 minutes; the code default is 7). `/report` answers right away; `/peak` fills in as the backfill progresses and says so in `coverage`.

Without Docker for the service: `docker compose up -d postgres`, then `npm ci && npm run dev` (reads `.env`).

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | required | Base RPC (read-only calls only) |
| `VAULTS` | demo vault | comma-separated V2 vaults to track |
| `DATABASE_URL` | `postgres://app:app@localhost:5433/oracle` | Postgres (host port 5433: 5432 is often taken locally) |
| `CONFIRMATIONS` | 20 | blocks behind the head before indexing |
| `BACKFILL_DAYS` | 7 | history to index on first start |
| `PORT` | 3000 | HTTP port |

## API

Every response carries `block` and `asOf`. Amounts are decimal strings; `*Pct` fields are percentages. Errors: `{ "error": { "code", "message" } }` (`INVALID_ADDRESS`, `VAULT_NOT_TRACKED`, `INVALID_PARAMETER`, `BLOCK_NOT_AVAILABLE`, `RPC_UNAVAILABLE`, `INTERNAL_ERROR`).

```bash
V=0xbeeff2490FEffa212faC2f6553682C219E6a8845
curl -s localhost:3000/vaults/$V/report | jq                    # the report, latest block
curl -s "localhost:3000/vaults/$V/report?block=53000000" | jq   # at a past block
curl -s "localhost:3000/vaults/$V/peak?days=30" | jq            # peak share per assumption + coverage
```

`/report` has `exposures` (per assumption: share, frozen-for, worst-case breakpoints, markets), `idle`, `noAssumption` (collateral priced as itself, e.g. WETH by ETH/USD) and `unknown` (markets with a `reasonCode`, plus `adapters` we could not read: money behind them counts as unknown, never idle); the four add up to 100%. If the RPC is down it answers 503.

## Tests

```bash
npm test               # unit tests; fixtures are real Base eth_call answers; DB tests run if DATABASE_URL is set
npm run test:live      # also hits Base through RPC_URL (decoder, vault reader, demo vault report)
npm run typecheck
```

DB tests (peak query, idempotent inserts, checkpoints) run in a throwaway schema. Indexer tests cover idempotent replay, resume from the checkpoint, confirmation depth, and rollback on a hash mismatch.

## Limits (read before trusting a number)

- **Lender side only**, on the collateral. Quote-side feeds (the loan token's price) are ignored. No risk score.
- **`frozenFor` of a MetaOracle is a minimum**: the switch to the backup is permissionless but someone must trigger it. For several markets under one assumption, `frozenFor` comes from the largest market; breakpoints are the lowest.
- **Chainlink thresholds** (`deviationPct`, `heartbeatSeconds`) come from Chainlink's reference-data directory. Morpho's feeds appear there as the secondary proxy of a pair; that they share the pair's thresholds is assumed, not verified.
- **`/peak` reads the database only**: `currentSharePct` is the latest stored snapshot, and `block`/`asOf` say which one (old during the first backfill). The peak is a lower bound: snapshots are taken at allocation events (at most one per 10 minutes). Interest accrual and MetaOracle state changes between events are not captured. `coverage.windowComplete` says whether the window is covered.
- Event windows use Base's 2 s block time; one RPC URL; the tracked vault list is fixed in config.
- Feeds not in the registry, such as the two mGLO "PriceLowered" feeds, stay `unknown` until someone confirms what they measure and opens a registry PR.

What was left out on purpose is in BusinessCase.md ("With more time").
