import { describe, expect, it } from 'vitest';
import { breakpoints } from '../../src/analysis/breakpoints.js';

describe('breakpoints', () => {
  it('LLTV 91.5%: drain 8.5%, bad debt 6.1%', () => {
    expect(breakpoints(915000000000000000n)).toEqual({ drainPct: 8.5, badDebtPct: 6.1 });
  });

  it('LLTV 62.5%: LIF 1.1268, bad debt 29.6%', () => {
    expect(breakpoints(625000000000000000n)).toEqual({ drainPct: 37.5, badDebtPct: 29.6 });
  });

  it('LLTV 30%: LIF capped at 1.15, bad debt 65.5%', () => {
    expect(breakpoints(300000000000000000n)).toEqual({ drainPct: 70, badDebtPct: 65.5 });
  });
});
