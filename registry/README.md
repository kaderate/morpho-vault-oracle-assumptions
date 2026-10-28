# Registry

What a feed or a token **means** is decided here, never guessed from `description()`.
Anything missing from these files is reported as `unknown`.

- `feeds.json`: feed address → `{ description, base, quote, type: market | exchange_rate, deviationPct?, heartbeatSeconds?, source? }`.
  `deviationPct` and `heartbeatSeconds` come from Chainlink's reference-data-directory (`source`); left out when not confirmed.
- `tokens.json`: collateral token address → `{ symbol, peg?: "USD", trivialWith?: [assets] }`.
  `trivialWith` lists assets that are the same thing as the token (WETH = ETH), so pricing it with them is no assumption.

Not listed on purpose: the two mGLO "PriceLowered" feeds. Their meaning is unconfirmed, so the mGLO markets show as `unknown`.
To add an entry: run `scripts/list-registry-candidates.ts <vault>`, read the feed's docs, then open a PR.
