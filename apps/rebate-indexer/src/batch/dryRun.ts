import {
  createPublicClient,
  encodeFunctionData,
  http,
  type PublicClient,
} from 'viem';
import { logger } from '../logger.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';

const log = logger.child({ module: 'dry-run' });

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface Transfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface SimulateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export type SimulateFn = (batch: readonly Transfer[]) => Promise<SimulateResult>;

/**
 * Real eth_call simulator. ok=true if every transfer in the batch succeeds.
 *
 * The real payout is a Safe DELEGATECALL to MultiSendCallOnly, so each inner
 * WETH.transfer runs with msg.sender = the SAFE. We model that directly:
 * eth_call each transfer FROM the Safe TO the WETH token.
 *
 * The old code did a plain `call` from the Safe TO the multisend contract — but
 * a plain CALL is not a DELEGATECALL, so the inner transfers would run from the
 * multisend contract (which holds no WETH), reverting EVERY transfer. That made
 * the dry-run quarantine every recipient and propose no payout at all.
 */
export function buildEthCallSimulator(opts: {
  chainId: number;
  rpcUrl: string;
}): SimulateFn {
  const client: PublicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  const weth = WETH_BY_CHAIN[opts.chainId];
  if (!weth) throw new Error(`no WETH configured for chain ${opts.chainId}`);

  return async (batch) => {
    if (batch.length === 0) return { ok: true };
    for (const t of batch) {
      const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [t.to, t.amount] });
      try {
        await client.call({ account: OPHIS_SAFE_ADDRESS, to: weth, data });
      } catch (err: any) {
        return { ok: false, reason: err?.shortMessage ?? err?.message ?? 'transfer eth_call reverted' };
      }
    }
    return { ok: true };
  };
}

/**
 * Walk the batch to find recipients whose transfer reverts.
 *
 *   1. Try the full batch. If ok → no bad recipients.
 *   2. For each transfer, simulate it alone. Mark every one whose simulation fails.
 *
 * The single-element loop is N RPC calls — fine for ~50 recipients/month.
 */
export async function isolateBadRecipients(
  transfers: readonly Transfer[],
  simulate: SimulateFn,
): Promise<{ good: Transfer[]; bad: Transfer[] }> {
  const first = await simulate(transfers);
  if (first.ok) return { good: [...transfers], bad: [] };

  log.warn({ reason: first.reason, count: transfers.length }, 'full batch sim failed, isolating');
  const good: Transfer[] = [];
  const bad: Transfer[] = [];
  for (const t of transfers) {
    const r = await simulate([t]);
    if (r.ok) good.push(t);
    else {
      log.warn({ to: t.to, amount: t.amount.toString(), reason: r.reason }, 'recipient quarantined');
      bad.push(t);
    }
  }
  return { good, bad };
}
