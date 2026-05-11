import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { logger } from '../logger.js';
import { buildRebateMultisend } from './multisend.js';
import { multiSendCallOnlyAddress, OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';

const log = logger.child({ module: 'dry-run' });

export interface Transfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface SimulateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export type SimulateFn = (batch: readonly Transfer[]) => Promise<SimulateResult>;

/** Run a real eth_call against an RPC, returning ok=true if the multiSend doesn't revert. */
export function buildEthCallSimulator(opts: {
  chainId: number;
  rpcUrl: string;
}): SimulateFn {
  const client: PublicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  const weth = WETH_BY_CHAIN[opts.chainId];
  if (!weth) throw new Error(`no WETH configured for chain ${opts.chainId}`);
  const multiSend = multiSendCallOnlyAddress(opts.chainId);

  return async (batch) => {
    if (batch.length === 0) return { ok: true };
    const calldata = buildRebateMultisend(batch, weth);
    try {
      await client.call({
        account: OPHIS_SAFE_ADDRESS,                                   // simulate as if Safe is the sender (DELEGATECALL context)
        to: multiSend,
        data: calldata,
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.shortMessage ?? err?.message ?? 'eth_call reverted' };
    }
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
