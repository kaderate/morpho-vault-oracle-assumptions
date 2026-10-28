import { hexToString, trim } from 'viem';
import type { Address, ChainReader, Position } from '../types.js';
import {
  erc20Abi, erc20Bytes32Abi, MORPHO, marketAdapterAbi, morphoAbi, vaultAdapterAbi, vaultV1Abi, vaultV2Abi,
} from './abis.js';
import { read } from './call.js';

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
  if (v === null) throw new Error(`${fn}(${args.join(',')}) on ${to} reverted`);
  return v;
}

export async function readToken(reader: ChainReader, token: Address, block?: bigint): Promise<{ symbol: string; decimals: number }> {
  let symbol = await read<string>(reader, token, erc20Abi, 'symbol', [], block);
  if (symbol === null) {
    const raw = await read<`0x${string}`>(reader, token, erc20Bytes32Abi, 'symbol', [], block);
    if (raw !== null) symbol = hexToString(trim(raw, { dir: 'right' }));
  }
  const decimals = await need<number>(reader, token, erc20Abi, 'decimals', [], block);
  return { symbol: symbol ?? token, decimals };
}

// Name and asset only: enough for the vault list, without reading any position.
export async function readVaultMeta(reader: ChainReader, vault: Address, block?: bigint): Promise<Pick<VaultState, 'name' | 'asset'>> {
  const assetAddress = await need<Address>(reader, vault, vaultV2Abi, 'asset', [], block);
  const name = await need<string>(reader, vault, vaultV2Abi, 'name', [], block);
  return { name, asset: { address: assetAddress, ...(await readToken(reader, assetAddress, block)) } };
}

export async function readVault(reader: ChainReader, vault: Address, block?: bigint): Promise<VaultState> {
  const totalAssets = await need<bigint>(reader, vault, vaultV2Abi, 'totalAssets', [], block);
  const { name, asset } = await readVaultMeta(reader, vault, block);
  const count = Number(await need<bigint>(reader, vault, vaultV2Abi, 'adaptersLength', [], block));

  const byMarket = new Map<`0x${string}`, bigint>();
  const unknownAdapters: Address[] = [];
  const add = (positions: Position[]) => {
    for (const p of positions) byMarket.set(p.marketId, (byMarket.get(p.marketId) ?? 0n) + p.assets);
  };

  for (let i = 0; i < count; i++) {
    const adapter = await need<Address>(reader, vault, vaultV2Abi, 'adapters', [BigInt(i)], block);
    const v1 = await read<Address>(reader, adapter, vaultAdapterAbi, 'morphoVaultV1', [], block);
    if (v1 !== null) {
      add(await readVaultAdapter(reader, adapter, v1, block));
      continue;
    }
    const n = await read<bigint>(reader, adapter, marketAdapterAbi, 'marketIdsLength', [], block);
    if (n !== null) {
      add(await readMarketAdapter(reader, adapter, Number(n), block));
      continue;
    }
    unknownAdapters.push(adapter);
  }

  const positions = [...byMarket].filter(([, assets]) => assets > 0n).map(([marketId, assets]) => ({ marketId, assets }));
  return { name, asset, totalAssets, positions, unknownAdapters };
}

// MorphoMarketV1 adapter: it reports its own supply per market.
async function readMarketAdapter(reader: ChainReader, adapter: Address, n: number, block?: bigint): Promise<Position[]> {
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const marketId = await need<`0x${string}`>(reader, adapter, marketAdapterAbi, 'marketIds', [BigInt(i)], block);
    const assets = await need<bigint>(reader, adapter, marketAdapterAbi, 'expectedSupplyAssets', [marketId], block);
    out.push({ marketId, assets });
  }
  return out;
}

// MorphoVaultV1Adapter: the V2 vault holds V1 shares. One level in, the V1 vault's Morpho positions
// are scaled so they add up to what the adapter really holds (realAssets), rounding leftovers to the last market.
async function readVaultAdapter(reader: ChainReader, adapter: Address, v1: Address, block?: bigint): Promise<Position[]> {
  const real = await need<bigint>(reader, adapter, vaultAdapterAbi, 'realAssets', [], block);
  const n = Number(await need<bigint>(reader, v1, vaultV1Abi, 'withdrawQueueLength', [], block));
  const raw: Position[] = [];
  for (let i = 0; i < n; i++) {
    const marketId = await need<`0x${string}`>(reader, v1, vaultV1Abi, 'withdrawQueue', [BigInt(i)], block);
    const [shares] = await need<readonly [bigint, bigint, bigint]>(reader, MORPHO, morphoAbi, 'position', [marketId, v1], block);
    if (shares === 0n) continue;
    const m = await need<readonly bigint[]>(reader, MORPHO, morphoAbi, 'market', [marketId], block);
    // Morpho's toAssetsDown with virtual shares: shares * (totalAssets + 1) / (totalShares + 1e6)
    raw.push({ marketId, assets: (shares * (m[0]! + 1n)) / (m[1]! + 1_000_000n) });
  }
  const total = raw.reduce((s, p) => s + p.assets, 0n);
  if (total === 0n) return [];
  const scaled = raw.map((p) => ({ marketId: p.marketId, assets: (p.assets * real) / total }));
  const leftover = real - scaled.reduce((s, p) => s + p.assets, 0n);
  scaled[scaled.length - 1]!.assets += leftover;
  return scaled;
}
