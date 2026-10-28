import { describe, expect, it } from 'vitest';
import {
  erc20Abi, MORPHO, marketAdapterAbi, morphoAbi, vaultAdapterAbi, vaultV1Abi, vaultV2Abi,
} from '../../src/chain/abis.js';
import { RevertedError } from '../../src/chain/errors.js';
import { readMarket } from '../../src/chain/marketReader.js';
import { readToken, readVault } from '../../src/chain/vaultReader.js';
import type { Address } from '../../src/types.js';
import { FakeChain } from '../helpers/fakeChain.js';
import { id } from '../helpers/vaultScenario.js';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const VAULT = a(0x100), USDC = a(0x200), ADAPTER = a(0x300), V1 = a(0x400), V1_ADAPTER = a(0x500);

function baseVault(chain: FakeChain, adapters: Address[], totalAssets: bigint) {
  chain
    .on(VAULT, vaultV2Abi, 'name', [], 'Test Vault')
    .on(VAULT, vaultV2Abi, 'asset', [], USDC)
    .on(VAULT, vaultV2Abi, 'totalAssets', [], totalAssets)
    .on(VAULT, vaultV2Abi, 'adaptersLength', [], BigInt(adapters.length))
    .on(USDC, erc20Abi, 'symbol', [], 'USDC')
    .on(USDC, erc20Abi, 'decimals', [], 6);
  adapters.forEach((ad, i) => chain.on(VAULT, vaultV2Abi, 'adapters', [BigInt(i)], ad));
}

describe('readVault', () => {
  it('reads a MorphoMarketV1 adapter and drops zero positions', async () => {
    const chain = new FakeChain();
    baseVault(chain, [ADAPTER], 1_000n);
    chain
      .on(ADAPTER, marketAdapterAbi, 'marketIdsLength', [], 3n)
      .on(ADAPTER, marketAdapterAbi, 'marketIds', [0n], id(1))
      .on(ADAPTER, marketAdapterAbi, 'marketIds', [1n], id(2))
      .on(ADAPTER, marketAdapterAbi, 'marketIds', [2n], id(3))
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(1)], 700n)
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(2)], 250n)
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(3)], 0n);
    const v = await readVault(chain, VAULT);
    expect(v.name).toBe('Test Vault');
    expect(v.asset).toEqual({ address: USDC, symbol: 'USDC', decimals: 6 });
    expect(v.totalAssets).toBe(1_000n);
    expect(v.positions).toEqual([{ marketId: id(1), assets: 700n }, { marketId: id(2), assets: 250n }]);
    expect(v.unknownAdapters).toEqual([]);
  });

  it('reads one level into a MorphoVaultV1Adapter, scaled to realAssets', async () => {
    const chain = new FakeChain();
    baseVault(chain, [V1_ADAPTER], 1_001n);
    chain
      .on(V1_ADAPTER, vaultAdapterAbi, 'morphoVaultV1', [], V1)
      .on(V1_ADAPTER, vaultAdapterAbi, 'realAssets', [], 1_001n)
      .on(V1, vaultV1Abi, 'withdrawQueueLength', [], 2n)
      .on(V1, vaultV1Abi, 'withdrawQueue', [0n], id(1))
      .on(V1, vaultV1Abi, 'withdrawQueue', [1n], id(2));
    // Shares are worth ~1 asset per 1e6 shares (Morpho's virtual offset): about 300k and 700k assets.
    for (const [m, shares] of [[id(1), 300_000n * 10n ** 6n], [id(2), 700_000n * 10n ** 6n]] as const) {
      chain
        .on(MORPHO, morphoAbi, 'position', [m, V1], [shares, 0n, 0n])
        .on(MORPHO, morphoAbi, 'market', [m], [10_000_000n, 10_000_000n * 10n ** 6n, 0n, 0n, 0n, 0n]);
    }
    const v = await readVault(chain, VAULT);
    expect(v.positions.map((p) => p.marketId)).toEqual([id(1), id(2)]);
    const sum = v.positions.reduce((s, p) => s + p.assets, 0n);
    expect(sum === 1_001n).toBe(true); // equals realAssets exactly
    expect(v.positions[1]!.assets > v.positions[0]!.assets).toBe(true);
  });

  it('lists an unrecognized adapter and still reads the others', async () => {
    const chain = new FakeChain();
    const weird = a(0x600);
    baseVault(chain, [weird, ADAPTER], 500n);
    chain
      .on(ADAPTER, marketAdapterAbi, 'marketIdsLength', [], 1n)
      .on(ADAPTER, marketAdapterAbi, 'marketIds', [0n], id(1))
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(1)], 400n);
    const v = await readVault(chain, VAULT);
    expect(v.unknownAdapters).toEqual([weird]);
    expect(v.positions).toEqual([{ marketId: id(1), assets: 400n }]);
  });

  it('an adapter whose getters revert is listed as unknown; the other adapters are still read', async () => {
    const chain = new FakeChain();
    const broken = a(0x601);
    baseVault(chain, [broken, ADAPTER], 500n);
    chain
      .on(broken, marketAdapterAbi, 'marketIdsLength', [], 1n) // looks like a market adapter, but marketIds(0) reverts
      .on(ADAPTER, marketAdapterAbi, 'marketIdsLength', [], 1n)
      .on(ADAPTER, marketAdapterAbi, 'marketIds', [0n], id(1))
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(1)], 400n);
    const v = await readVault(chain, VAULT);
    expect(v.unknownAdapters).toEqual([broken]);
    expect(v.positions).toEqual([{ marketId: id(1), assets: 400n }]);
  });

  it('throws when the vault itself does not answer', async () => {
    await expect(readVault(new FakeChain(), VAULT)).rejects.toThrow(/totalAssets/);
    await expect(readVault(new FakeChain(), VAULT)).rejects.toBeInstanceOf(RevertedError);
  });
});

describe('readMarket', () => {
  it('returns market params, including a zero-address collateral (idle market)', async () => {
    const chain = new FakeChain().on(MORPHO, morphoAbi, 'idToMarketParams', [id(7)], [USDC, a(0), a(0), a(0), 0n]);
    expect(await readMarket(chain, id(7))).toEqual({ id: id(7), loan: USDC, collateral: a(0), oracle: a(0), lltv: 0n });
  });

  it('returns null for a market that does not exist', async () => {
    const chain = new FakeChain().on(MORPHO, morphoAbi, 'idToMarketParams', [id(8)], [a(0), a(0), a(0), a(0), 0n]);
    expect(await readMarket(chain, id(8))).toBeNull();
  });
});

describe('readToken', () => {
  it('falls back to the address when the symbol cannot be decoded', async () => {
    const T = a(0x700);
    const chain = new FakeChain().on(T, erc20Abi, 'decimals', [], 18); // symbol() reverts
    expect(await readToken(chain, T)).toEqual({ symbol: T, decimals: 18 });
  });
});
