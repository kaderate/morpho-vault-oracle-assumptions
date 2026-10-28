# AGENTS.md

Take-home for a staff backend role at Morpho. **Time box: 4 hours.** A small, well-scoped, well-tested service beats a sprawling prototype.

## What this project is

**Vault Oracle Assumption Report**: for a Morpho Vault V2 on Base, show which hidden bets its oracles rely on (e.g. "USDe = $1"), how much of the vault rests on each, and how long the oracle stays blind if one breaks.

Read before coding, in this order:
1. `ASSESSEMENT.md`: the brief and the evaluation criteria.
2. `BusinessCase.md`: why this project (one page, keep it one page).
3. `docs/superpowers/specs/2026-10-28-vault-oracle-assumption-report-design.md`: what to build, the time budget, the **cut order**.
4. `ARCHITECTURE.md`: the shape (to be mentioned in the README).

## Hard rules (from the brief)

- TypeScript. A real data store (Postgres). REST API.
- Onchain data comes **from the chain over an RPC**. Never from the Morpho API. (The Morpho API was used only for research, to list markets.)
- Read-only: never send a transaction, never write a smart contract.
- No frontend, no K8s, no CI, no Terraform. `docker compose up` must boot the service.
- Handle error cases, data integrity and failure paths. Do not swallow errors.
- **No code the author can't explain.** Prefer simple, readable code over clever code.

## Scope discipline

- Do exactly what the spec says. If an idea is not in the spec, it goes in "With more time" in `BusinessCase.md`, not in the code.
- When behind schedule, cut in the spec's order. Never cut tests on the analysis and decoder.
- Lender side only: report assumptions on the **collateral**, not the quote side. No risk score, no 1-to-5 levels, no `threatensLender` field.

## Domain rules (verified, do not re-derive differently)

- Market parameters, oracle included, are **immutable**. What changes: vault allocations, caps, MetaOracle state.
- `drain = 1 − LLTV`; `badDebt = 1 − LLTV × LIF`; `LIF = min(1.15, 1 / (0.3 × LLTV + 0.7))`. At LLTV 91.5%: 8.5% and ~6.1%.
- A feed's meaning comes from the **registry in the repo** (`registry/*.json`), never guessed from `description()`. `description()` only pre-fills a registry PR. Anything missing is `unknown` and reported apart from the numbers.
- Real V2 vaults can sit behind a `MorphoVaultV1Adapter` pointing to a V1 vault: read **one** level into it.
- Amounts are `bigint` in code and strings in JSON. Never use `number` for token amounts.
- Every API response carries `block` and `asOf`. Unknown data is flagged, not hidden; the service never serves old data as current (RPC down = 503).

## Stack and layout

Node 22, TypeScript (strict), viem, Fastify, zod, `pg` with plain SQL migrations, vitest, docker compose.

```
src/config.ts
src/chain/       client, vault reader, oracle decoder
src/analysis/    pure functions: assumptions, breakpoints, frozen-for
src/indexer/     logs, snapshots, checkpoint, rollback
src/db/          migrations (*.sql), repository
src/api/         routes, schemas
registry/        feeds.json, tokens.json
test/            unit tests and fixtures (real Base data)
```

Keep `analysis/` free of I/O. Put all chain and DB access behind small interfaces so they can be mocked.

## Commands (planned, update once the scaffold exists)

```
npm run dev        # run the service locally
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint
docker compose up  # Postgres + service
```

Run `npm run typecheck` and `npm test` before saying something is done.

## Testing

- Fixtures come from **real Base data**, not invented numbers (e.g. the USDe/USDC MetaOracle, the cbBTC/USDC Chainlink oracle).
- Test the indexer for idempotent replay, resume from checkpoint, and rollback on a hash mismatch.
- If a claim in a doc comes from a number, that number must be reproducible from a script or a test.

## Docs and style

- Repo docs are in English, short, plain. Match the tone of `BusinessCase.md`: direct, no filler.
- Do not state something as verified unless it was checked (RPC call, test, or a primary source). Mark the rest as unverified.
- No secrets in the repo: RPC URLs and keys go in `.env` (git-ignored), with a `.env.example`.
- Don't commit or push unless asked.
