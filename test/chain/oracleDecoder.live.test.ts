import { describe, expect, it } from 'vitest';
import { decodeOracle } from '../../src/chain/oracleDecoder.js';
import { liveReader } from '../helpers/liveReader.js';

describe.skipIf(!process.env.RPC_URL)('decodeOracle on Base', () => {
  const reader = () => liveReader(process.env.RPC_URL as string);

  it('USDe/USDC oracle is a MetaOracle with a fixed primary and a chainlink backup', async () => {
    const o = await decodeOracle(reader(), '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47');
    expect(o).toMatchObject({ class: 'metaoracle', challengeSeconds: 57600, primary: { class: 'fixed' }, backup: { class: 'chainlink' } });
  });

  it('cbBTC/USDC oracle is chainlink with one feed', async () => {
    const o = await decodeOracle(reader(), '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9');
    expect(o).toMatchObject({ class: 'chainlink', feeds: ['0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F'] });
  });
});
