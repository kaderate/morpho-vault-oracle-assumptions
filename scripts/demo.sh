#!/usr/bin/env bash
# Calls the main endpoints for the demo vault. Usage: scripts/demo.sh [base-url]   (needs curl and jq)
set -euo pipefail
BASE="${1:-http://localhost:3000}"
VAULT=0xbeeff2490FEffa212faC2f6553682C219E6a8845

echo "== /vaults/$VAULT/report: what the vault bets on"
curl -s "$BASE/vaults/$VAULT/report" | jq -r '
  "block \(.block) as of \(.asOf), total \(.totalAssets) \(.asset.symbol)",
  (.exposures[] | "  \(.sharePct)%  \(.assumption)  | oracle frozen: \(.frozenFor.human)  | drain \(.breakpoints.drainPct)%, bad debt \(.breakpoints.badDebtPct)%"),
  "  unknown: \(.unknown.sharePct)%  | no assumption: \(.noAssumption.sharePct)%  | idle: \(.idle.sharePct)%"'

echo; echo "== /vaults/$VAULT/peak?days=30"
curl -s "$BASE/vaults/$VAULT/peak?days=30" | jq -r '
  "snapshots: \(.coverage.snapshots), since \(.coverage.from), window complete: \(.coverage.windowComplete)",
  (.peaks[] | "  \(.assumption): now \(.currentSharePct)%, peak \(.peakSharePct)% at block \(.peakBlock)")'

