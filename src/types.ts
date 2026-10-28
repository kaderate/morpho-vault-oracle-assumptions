export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export interface Position { marketId: Hex; assets: bigint }
export interface MarketInfo { id: Hex; loan: Address; collateral: Address; oracle: Address; lltv: bigint /* 1e18 */ }
export type ReasonCode =
  | 'FEED_NOT_IN_REGISTRY'
  | 'TOKEN_NOT_IN_REGISTRY'
  | 'FIXED_PRICE_UNPEGGED'
  | 'ORACLE_REVERTED'
  | 'ORACLE_UNSUPPORTED'
  | 'UNKNOWN_ADAPTER'
  | 'TOKEN_UNREADABLE';
export type DecodedOracle =
  | { class: 'fixed'; address: Address }
  | { class: 'chainlink'; address: Address; feeds: Address[] }
  | {
      class: 'metaoracle';
      address: Address;
      primary: DecodedOracle;
      backup: DecodedOracle;
      challengeSeconds: number;
      challengeExpiresAt?: number;
      state: 'primary' | 'challenged' | 'backup' | 'healing';
    }
  | { class: 'unknown'; address: Address; reasonCode: ReasonCode; reason: string };
export type FrozenFor =
  | { kind: 'unbounded' }
  | { kind: 'timelock'; seconds: number; state: string; expiresAt?: number }
  | { kind: 'feed_heartbeat'; deviationPct: number; heartbeatSeconds: number }
  | { kind: 'unknown'; reasonCode: ReasonCode };
export interface ChainReader {
  call(to: Address, data: Hex, block?: bigint): Promise<Hex | null>; // null on revert
  blockNumber(): Promise<bigint>;
  latest(): Promise<{ number: bigint; hash: Hex; timestamp: number }>; // head block header, one call
  block(n: bigint): Promise<{ number: bigint; hash: Hex; timestamp: number }>;
  logs(p: { addresses: Address[]; topics0: Hex[]; from: bigint; to: bigint }): Promise<
    { address: Address; blockNumber: bigint; txHash: Hex; logIndex: number }[]
  >;
}
