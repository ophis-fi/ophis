import SafeApiKit from '@safe-global/api-kit';
import { OPHIS_SAFE_ADDRESS } from '../safe/addresses.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'poll' });

export interface PollResult {
  readonly executed: boolean;
  readonly isSuccessful: boolean | null;
  readonly transactionHash: `0x${string}` | null;
}

/** One-shot status check. Caller decides cadence. */
export async function getProposalStatus(chainId: number, safeTxHash: `0x${string}`): Promise<PollResult> {
  const apiKit = new SafeApiKit({ chainId: BigInt(chainId) });
  const tx = await apiKit.getTransaction(safeTxHash);
  return {
    executed: Boolean(tx.isExecuted),
    isSuccessful: tx.isSuccessful ?? null,
    transactionHash: (tx.transactionHash ?? null) as `0x${string}` | null,
  };
}

/**
 * Poll Safe TX Service until executed (or timeout). Used by the batcher's tail
 * after proposing. Long-running — we don't block cron, we run this in the background
 * as a fire-and-forget after proposeTransaction returns.
 */
export async function waitForExecution(opts: {
  chainId: number;
  safeTxHash: `0x${string}`;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<PollResult> {
  const interval = opts.intervalMs ?? 60_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 7 * 24 * 60 * 60 * 1000); // 7 days default
  while (Date.now() < deadline) {
    const r = await getProposalStatus(opts.chainId, opts.safeTxHash);
    if (r.executed) {
      log.info({ safeTxHash: opts.safeTxHash, ...r }, 'execution observed');
      return r;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  log.warn({ safeTxHash: opts.safeTxHash, after: 'timeout' }, 'gave up polling');
  return { executed: false, isSuccessful: null, transactionHash: null };
}

