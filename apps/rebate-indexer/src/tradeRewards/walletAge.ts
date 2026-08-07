import { createPublicClient, http, type PublicClient } from 'viem';
import { getRpcClient } from '../rpc/client.js';
import {
  TRADE_REWARDS_ELIGIBLE_CHAIN_IDS,
  TRADE_REWARDS_WALLET_AGE_DAYS,
} from './config.js';

export interface WalletAgeEvidence {
  readonly chainId: number;
  readonly cutoffBlock: bigint;
  readonly cutoffTimestamp: Date;
  readonly historicalNonce: number;
  readonly hadContractCode: boolean;
}

interface HistoricalRpc {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getTransactionCount(args: { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
  getCode(args: { address: `0x${string}`; blockNumber: bigint }): Promise<`0x${string}` | undefined>;
}

const walletAgeClients = new Map<number, PublicClient>();

function walletAgeRpcClient(chainId: number): PublicClient {
  const configured = process.env[`WALLET_AGE_RPC_URL_${chainId}`]?.trim();
  if (!configured) return getRpcClient(chainId);
  const cached = walletAgeClients.get(chainId);
  if (cached) return cached;
  const client = createPublicClient({ transport: http(configured, { timeout: 15_000 }) });
  walletAgeClients.set(chainId, client);
  return client;
}

async function blockAtOrBefore(client: HistoricalRpc, cutoffSeconds: bigint): Promise<bigint> {
  let low = 0n;
  let high = await client.getBlockNumber();
  const latest = await client.getBlock({ blockNumber: high });
  if (latest.timestamp <= cutoffSeconds) return high;

  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp <= cutoffSeconds) low = mid;
    else high = mid - 1n;
  }
  return low;
}

export async function walletAgeEvidenceOnChain(
  wallet: `0x${string}`,
  chainId: number,
  cutoff: Date,
  client: HistoricalRpc = walletAgeRpcClient(chainId),
): Promise<WalletAgeEvidence | null> {
  const cutoffSeconds = BigInt(Math.floor(cutoff.getTime() / 1_000));
  const cutoffBlock = await blockAtOrBefore(client, cutoffSeconds);
  const [historicalNonce, code] = await Promise.all([
    client.getTransactionCount({ address: wallet, blockNumber: cutoffBlock }),
    client.getCode({ address: wallet, blockNumber: cutoffBlock }),
  ]);
  const hadContractCode = code !== undefined && code !== '0x';
  if (historicalNonce === 0 && !hadContractCode) return null;
  return { chainId, cutoffBlock, cutoffTimestamp: cutoff, historicalNonce, hadContractCode };
}

export async function findWalletAgeEvidence(
  wallet: `0x${string}`,
  settledAt: Date,
): Promise<WalletAgeEvidence | null> {
  const cutoff = new Date(settledAt.getTime() - TRADE_REWARDS_WALLET_AGE_DAYS * 24 * 60 * 60 * 1_000);
  const checks = await Promise.allSettled(
    TRADE_REWARDS_ELIGIBLE_CHAIN_IDS.map((chainId) =>
      walletAgeEvidenceOnChain(wallet, chainId, cutoff),
    ),
  );
  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value !== null) return check.value;
  }
  const failures = checks.filter((check) => check.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `wallet-age verification incomplete: ${failures.length}/${checks.length} archive RPC checks failed`,
    );
  }
  return null;
}
