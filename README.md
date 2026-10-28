# Vault Oracle Assumption Report

For a Morpho Vault V2 on Base: which hidden bets its oracles rely on (e.g. "USDe = $1"), how much of the vault rests on each, how long the oracle can stay blind if one breaks, and the peak exposure over time. Why this project: [BusinessCase.md](BusinessCase.md).

Demo vault, read on-chain on 2026-10-28: about 76% assumes `USDe = 1 USD`. Its oracle can keep that price **at least 16h** after a depeg. Bad debt starts about **6.1%** below $1. About 20% is `unknown` (feed not in the registry).

## Architecture

The service answers two questions about a Morpho Vault V2: what its oracles assume right now, and how high each assumption has peaked. The first is computed live, by reading the vault, its markets and their oracles on Base at a single block; the second comes from snapshots that a background indexer stores in Postgres whenever the vault's allocations change. The two paths share only the RPC, and anything the registry does not know is reported as `unknown` instead of guessed.

```
Background (history)
  Base RPC ──► Indexer ──────► Postgres ──► GET /vaults/:a/peak
               events → one snapshot per 10-minute window

Per request (live)
  Base RPC ──► Readers ──► Oracle decoder ──► Analysis ──► GET /vaults/:a/report
               vault → markets   fixed | chainlink |   assumptions, breakpoints,
                                 metaoracle | unknown   frozen-for
```

- `/report` reads the chain live, at one pinned block; `/peak` reads Postgres only.
- The indexer is a polling loop (every 30 s, started with the service): `getLogs` for the vault's allocation events, one snapshot per event window.
- The registry (`registry/*.json`) decides what a feed or token *means*. Anything missing is `unknown`, never a guess.
- Design notes and failure paths: [ARCHITECTURE.md](ARCHITECTURE.md). Spec: [docs/superpowers/specs](docs/superpowers/specs/).
- Start reading at: `src/chain/oracleDecoder.ts`, `src/chain/vaultReader.ts`, `src/analysis/`, `src/report.ts`, `src/indexer/indexer.ts`.

## Run

Needs Docker and a Base RPC URL that serves past-block `eth_call` and `getLogs`.

```bash
cp .env.example .env        # set RPC_URL (never commit it)
docker compose up --build   # Postgres + service on http://localhost:3000
scripts/demo.sh             # calls the endpoints for the demo vault (needs jq)
```

Variables (see `.env.example`): `RPC_URL` (required), `VAULTS` (comma-separated V2 vaults; the demo vault in `.env.example`), `BACKFILL_DAYS` (code: 7, compose: 1; about 2 minutes per day). Postgres is published on `127.0.0.1:5433`. Without Docker for the service (Node 22+): `docker compose up -d postgres && npm ci && npm run dev`.

## API

Every response has `block` and `asOf`; amounts are decimal strings; `*Pct` are percentages. Errors are `{ "error": { "code", "message" } }`.

```bash
V=0xbeeff2490FEffa212faC2f6553682C219E6a8845
curl -s localhost:3000/vaults/$V/report | jq
curl -s "localhost:3000/vaults/$V/report?block=53000000" | jq
curl -s "localhost:3000/vaults/$V/peak?days=30" | jq
```

**`GET /vaults/:address/report[?block=N]`**: what the vault bets on, right now (or at block N). It reads the vault's money per market on-chain, decodes each market's oracle, and groups the money by assumption ("USDe = 1 USD"). For each assumption: its share of the vault, how long the oracle can stay frozen, and the price drop at which lenders are hit (liquidity drained / bad debt). Money that cannot be classified is listed apart (`unknown`, `noAssumption`, `idle`); all shares add up to 100%. RPC down: 503.

**`GET /vaults/:address/peak[?days=30]`**: how high each bet has been. From the stored snapshots, per assumption: its current share, its highest share in the window, and when (block and date). `coverage` says how much history exists, so a short history is never mistaken for a calm month.

## Tests

```bash
npm test                  # fixtures are real Base answers; DB tests are skipped without DATABASE_URL
DATABASE_URL=postgres://app:app@localhost:5433/oracle npm run test:live   # + DB tests, + live Base reads (needs RPC_URL)
npm run typecheck
```

## Limits

- Lender side only, on the collateral. No risk score.
- A MetaOracle's `frozenFor` is a **minimum**: switching to the backup must be triggered by someone.
- Chainlink thresholds come from Chainlink's reference-data directory; that Morpho's secondary proxies share the pair's thresholds is assumed, not verified.
- `/peak` is a lower bound (snapshots at allocation events, at most one per 10 minutes). Its "current" share is the latest stored snapshot (`asOf` says which; old during the first backfill). `coverage.windowComplete` says whether the window is covered.
- Feeds not in the registry (e.g. the two mGLO feeds) stay `unknown` until someone confirms them.
- During the first backfill the indexer and the API share one RPC client (3 requests in flight), so `/report` is slower. Running the indexer in a separate process would remove that.

Left out on purpose: see "With more time" in the BusinessCase.
