# Business Case — Vault Oracle Assumption Report

## The problem

A lender is only protected by liquidations, and liquidations only trigger when the **oracle** moves. But many oracles don't price the collateral itself. They price something *assumed* equivalent: a fixed $1, the underlying asset, a protocol exchange rate.

When that assumption breaks, nobody gets liquidated, and the remaining liquidity can be borrowed against overvalued collateral. It keeps happening:

- **xUSD** (Nov 2025): ~$700k bad debt in one vault.
- **Resolv wstUSR** (Mar 2026): ~15 vaults hit, priced at $1.13 while trading near $0.63. Estimates of Morpho bad debt range from ~$3.8M to ~$6.2M.

A depositor sees an APY and a curator name. They can't see these bets.

## What I built

A backend that answers one question for a Morpho vault on Base: **"which bets does my money rely on, and how long is the oracle blind if one breaks?"**

It reads the chain over an RPC, follows the vault's adapters to its markets, decodes each oracle, and returns:

1. **Exposure per assumption**, e.g. "39% of this vault bets USDe = $1".
2. **Two breakpoints per market**: the price drop that drains liquidity (1 − LLTV) and the smaller one that creates bad debt (~1 − LLTV × LIF).
3. **How long the oracle can stay frozen**, when it can be computed.
4. **30-day peak exposure**, since allocations can shift instantly.

No score, only facts. The reader decides.

**Real example** (read on-chain): the USDe/USDC market uses a Steakhouse MetaOracle. Its price is a constant $1.0. It only switches to a Chainlink fallback after a 0.5% deviation holds for **16 hours**, and only if someone triggers it. A depeg above ~6% in that window creates bad debt: liquidators earn a ~2.6% bonus, so the collateral must still cover ~94% of its value. The design resists manipulation, but depositors can't see the blind window.

## Why it matters to Morpho

Morpho leaves oracle choice to curators, and the incidents above were amplified by that choice. Making it visible helps depositors compare vaults, and lets careful curators (with fallback oracles) prove it.

## What already exists

| Existing | Gap |
|---|---|
| Credora (RedStone) vault ratings | Oracle modifier is qualitative, not quantified publicly |
| Morpho app warnings, Oracle Portal | Fire only once the price is 10x off; no vault view |
| Sigma Labs RFC (unfunded) | Badges in a registry, 6 months out |
| Chaos Labs, Gauntlet, Hypernative | Built for curators, compare oracle with market price |

Mine is vault-level, computed from the chain, and reproducible at a given block.

## Limits

- Base only. V2 vaults from a list, plus one V1 level behind an adapter. No UI, no price forecast.
- Only assumptions on the collateral side are reported, since they are the lender's risk.
- Feed meaning comes from a versioned registry in the repo. Unknown feeds are labeled *unknown*, never guessed.
- Market feeds react within minutes, so the value is mostly in fixed prices and MetaOracles.

## With more time

- **Alerts** (Telegram, webhooks). Market parameters are immutable, so what's worth alerting on is: allocation shifts, MetaOracle challenges or switches, and cap or adapter changes. Nobody polls an API, and the info only helps if it arrives before the window closes.
- Liquidity at risk per market, DEX price comparison, standalone V1 vaults, more chains.
