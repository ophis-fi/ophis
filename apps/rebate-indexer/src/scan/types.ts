import type { AppCode } from '../cow/types.js';

export interface TokenLeg {
  token: `0x${string}`;
  symbol: string | null;
  decimals: number | null;
  amount: string; // raw atoms (uint256 as decimal string)
}

export interface Swap {
  chainId: number;
  chainName: string;
  tsUtc: string;             // ISO8601; order creationDate (settlement is near-instant)
  orderUid: `0x${string}`;
  txHash: `0x${string}` | null;
  owner: `0x${string}`;      // on-chain owner (eth-flow router for native-ETH sells)
  receiver: `0x${string}`;   // actual recipient (the user, for eth-flow)
  sell: TokenLeg;
  buy: TokenLeg;
  appCode: AppCode;
  refCode: string | null;
  feeBps: number | null;
  notionalUsd: number | null;
}

export interface Coverage {
  chainId: number;
  chainName: string;
  status: 'ok' | 'degraded';
  fillsScanned: number;
  ophisFound: number;
  unresolved: number;
  error?: string;
}

export type ChainKind = 'local-db' | 'rpc';

export interface ChainConfig {
  chainId: number;
  name: string;
  kind: ChainKind;
  dbContainer?: string;      // local-db chains
  alchemySubdomain?: string; // rpc chains
}

export interface ScanResult {
  swaps: Swap[];
  coverage: Coverage;
}

// orderUid -> classification. 'none' = resolved, confirmed NOT Ophis (negative cache).
export type CachedClass = AppCode | 'none';
export interface ScanCache {
  get(uid: string): CachedClass | undefined;
  set(uid: string, v: CachedClass): void;
  save(): Promise<void>;
}
