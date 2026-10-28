const WAD = 10n ** 18n;
const MAX_LIF = 1.15;

const round1 = (x: number) => Math.round(x * 10) / 10;

// Price drops (in %) at which a market's lenders are hit. lltv is scaled by 1e18.
// Percentages are not token amounts, so number is fine here.
//   drain   = 1 - LLTV                  (borrowers sit at the liquidation line)
//   badDebt = 1 - LLTV * LIF            (collateral no longer covers debt plus the liquidation bonus)
//   LIF     = min(1.15, 1 / (0.3 * LLTV + 0.7))
export function breakpoints(lltv: bigint): { drainPct: number; badDebtPct: number } {
  const l = Number((lltv * 1_000_000n) / WAD) / 1_000_000;
  const lif = Math.min(MAX_LIF, 1 / (0.3 * l + 0.7));
  return { drainPct: round1((1 - l) * 100), badDebtPct: round1((1 - l * lif) * 100) };
}
