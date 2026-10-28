import type { Address, ChainReader, Position } from '../types.js';
import {
  erc20Abi, MORPHO, marketAdapterAbi, morphoAbi, vaultAdapterAbi, vaultV1Abi, vaultV2Abi,
} from './abis.js';
import { read } from './call.js';
import { RevertedError } from './errors.js';

export interface VaultState {
  name: string;
  asset: { address: Address; symbol: string; decimals: number };
  totalAssets: bigint;
  positions: Position[];
  unknownAdapters: Address[];
}

// A required getter that reverts is an error (the vault state would be wrong), never a silent default.
async function need<T>(reader: ChainReader, to: Address, abi: Parameters<typeof read>[2], fn: string, args: readonly unknown[], block?: bigint): Promise<T> {
  const v = await read<T>(reader, to, abi, fn, args, block);
  if (v === null) throw new RevertedError(`${fn}(${args.join(',')}) on ${to} reverted`);
  return v;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// symbol and decimals do not depend on each other: one round trip, not two.
export async function readToken(reader: ChainReader, token: Address, block?: bigint): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    read<string>(reader, token, erc20Abi, 'symbol', [], block), // a symbol that does not decode falls back to the address
    need<number>(reader, token, erc20Abi, 'decimals', [], block),
  ]);
  return { symbol: symbol ?? token, decimals };
}

// Reads are grouped by dependency: everything that does not need an earlier answer starts together, so
// the time is the number of dependent steps (a handful), not the number of calls.
export async function readVault(reader: ChainReader, vault: Address, block?: bigint): Promise<VaultState> {
  const [totalAssets, assetAddress, name, count] = await Promise.all([
    need<bigint>(reader, vault, vaultV2Abi, 'totalAssets', [], block),
    need<Address>(reader, vault, vaultV2Abi, 'asset', [], block),
    need<string>(reader, vault, vaultV2Abi, 'name', [], block),
    need<bigint>(reader, vault, vaultV2Abi, 'adaptersLength', [], block),
  ]);
  const [token, adapters] = await Promise.all([
    readToken(reader, assetAddress, block),
    Promise.all(range(Number(count)).map((i) => need<Address>(reader, vault, vaultV2Abi, 'adapters', [BigInt(i)], block))),
  ]);
  const perAdapter = await Promise.all(adapters.map((adapter) => readAdapter(reader, adapter, block)));

  const byMarket = new Map<`0x${string}`, bigint>();
  const unknownAdapters: Address[] = [];
  perAdapter.forEach((positions, i) => {
    if (positions === null) unknownAdapters.push(adapters[i]!);
    else for (const p of positions) byMarket.set(p.marketId, (byMarket.get(p.marketId) ?? 0n) + p.assets);
  });

  const positions = [...byMarket].filter(([, assets]) => assets > 0n).map(([marketId, assets]) => ({ marketId, assets }));
  return { name, asset: { address: assetAddress, ...token }, totalAssets, positions, unknownAdapters };
}

// null = an adapter we do not recognise, or one that looks like ours but reverts when read (reported as
// unknown). An outage still throws.
async function readAdapter(reader: ChainReader, adapter: Address, block?: bigint): Promise<Position[] | null> {
  try {
    const [v1, n] = await Promise.all([
      read<Address>(reader, adapter, vaultAdapterAbi, 'morphoVaultV1', [], block),
      read<bigint>(reader, adapter, marketAdapterAbi, 'marketIdsLength', [], block),
    ]);
    if (v1 !== null) return await readVaultAdapter(reader, adapter, v1, block);
    if (n !== null) return await readMarketAdapter(reader, adapter, Number(n), block);
    return null;
  } catch (e) {
    if (e instanceof RevertedError) return null;
    throw e;
  }
}

// MorphoMarketV1 adapter: it reports its own supply per market.
async function readMarketAdapter(reader: ChainReader, adapter: Address, n: number, block?: bigint): Promise<Position[]> {
  const ids = await Promise.all(range(n).map((i) => need<`0x${string}`>(reader, adapter, marketAdapterAbi, 'marketIds', [BigInt(i)], block)));
  const assets = await Promise.all(ids.map((id) => need<bigint>(reader, adapter, marketAdapterAbi, 'expectedSupplyAssets', [id], block)));
  return ids.map((marketId, i) => ({ marketId, assets: assets[i]! }));
}

// MorphoVaultV1Adapter: the V2 vault holds V1 shares. One level in, the V1 vault's Morpho positions
// are scaled so they add up to what the adapter really holds (realAssets), rounding leftovers to the last market.
async function readVaultAdapter(reader: ChainReader, adapter: Address, v1: Address, block?: bigint): Promise<Position[]> {
  const [real, n] = await Promise.all([
    need<bigint>(reader, adapter, vaultAdapterAbi, 'realAssets', [], block),
    need<bigint>(reader, v1, vaultV1Abi, 'withdrawQueueLength', [], block),
  ]);
  const ids = await Promise.all(range(Number(n)).map((i) => need<`0x${string}`>(reader, v1, vaultV1Abi, 'withdrawQueue', [BigInt(i)], block)));
  const held = await Promise.all(
    ids.map(async (marketId) => {
      const [[shares], m] = await Promise.all([
        need<readonly [bigint, bigint, bigint]>(reader, MORPHO, morphoAbi, 'position', [marketId, v1], block),
        need<readonly bigint[]>(reader, MORPHO, morphoAbi, 'market', [marketId], block),
      ]);
      // Morpho's toAssetsDown with virtual shares: shares * (totalAssets + 1) / (totalShares + 1e6)
      return shares === 0n ? null : { marketId, assets: (shares * (m[0]! + 1n)) / (m[1]! + 1_000_000n) };
    }),
  );
  const raw = held.filter((p): p is Position => p !== null);
  const total = raw.reduce((s, p) => s + p.assets, 0n);
  if (total === 0n) return [];
  const scaled = raw.map((p) => ({ marketId: p.marketId, assets: (p.assets * real) / total }));
  const leftover = real - scaled.reduce((s, p) => s + p.assets, 0n);
  scaled[scaled.length - 1]!.assets += leftover;
  return scaled;
}

// The V1 vaults behind the vault's MorphoVaultV1Adapters (their events also move the vault's money).
export async function resolveV1Vaults(reader: ChainReader, vault: Address, block?: bigint): Promise<Address[]> {
  const count = Number(await need<bigint>(reader, vault, vaultV2Abi, 'adaptersLength', [], block));
  const v1s = await Promise.all(
    range(count).map(async (i) => {
      const adapter = await need<Address>(reader, vault, vaultV2Abi, 'adapters', [BigInt(i)], block);
      return read<Address>(reader, adapter, vaultAdapterAbi, 'morphoVaultV1', [], block);
    }),
  );
  return v1s.filter((a): a is Address => a !== null);
}
