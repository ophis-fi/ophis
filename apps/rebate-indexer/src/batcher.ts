import { eq } from 'drizzle-orm';
import { sql, db, schema } from './db/index.js';
import { computeShares, type EligibleWallet } from './batch/computeShares.js';
import { buildEthCallSimulator, isolateBadRecipients, type Transfer } from './batch/dryRun.js';
import { proposeRebateBatch } from './batch/propose.js';
import { waitForExecution } from './batch/poll.js';
import { assignTier, POOL_SPLIT_BPS } from './tiers.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from './safe/addresses.js';
import { getNonWethTokenBalances } from './safe/balances.js';
import { alerts } from './telegram/alerter.js';
import { createPublicClient, http, parseAbi } from 'viem';
import { logger } from './logger.js';

const log = logger.child({ module: 'batcher' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface BatcherDeps {
  readonly chainId: number;                                            // payout chain (100 in Phase 1)
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly proposeEnabled: boolean;                                    // false for first-batch dry-run safety
}

export interface BatcherResult {
  readonly batchId: number;
  readonly status: 'computing' | 'proposed' | 'no_recipients' | 'failed';
  readonly safeTxHash: `0x${string}` | null;
  readonly recipientCount: number;
  readonly poolWei: bigint;
}

/** First-of-month detection in UTC. The cron entrypoint calls this. */
export function isFirstOfMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1;
}

function cycleMonthKey(now: Date): string {
  // YYYY-MM-01 of the cycle being paid out — i.e., the current month's 1st.
  // Example: running on 2026-06-01 02:00 UTC → '2026-06-01'.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export async function runBatcher(deps: BatcherDeps, now: Date = new Date()): Promise<BatcherResult> {
  const cycleMonth = cycleMonthKey(now);
  log.info({ cycleMonth, chainId: deps.chainId, proposeEnabled: deps.proposeEnabled }, 'batcher start');

  // 1. Read Safe WETH balance.
  const weth = WETH_BY_CHAIN[deps.chainId]!;
  const client = createPublicClient({ transport: http(deps.rpcUrl) });
  const netFee = await client.readContract({ address: weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
  const pool = (netFee * BigInt(POOL_SPLIT_BPS)) / 10_000n;

  // 2. Read eligible wallets.
  const eligible = await sql<{ wallet: Buffer; volume_30d_usd: string }[]>`
    SELECT wallet, volume_30d_usd::text FROM wallets WHERE volume_30d_usd > 0
  `;
  const wallets: EligibleWallet[] = eligible.map((r) => ({
    wallet: (`0x${r.wallet.toString('hex')}`) as `0x${string}`,
    volume_30d_usd: parseFloat(r.volume_30d_usd),
  }));

  // 3. Insert the batch row up-front so we have a stable ID even if subsequent steps fail.
  //    UNIQUE on cycle_month → idempotent: retrying the same month no-ops at the INSERT.
  let batchId: number;
  try {
    const inserted = await db
      .insert(schema.rebateBatches)
      .values({ cycleMonth: cycleMonth, netFeeWethWei: netFee, poolWethWei: pool, status: 'computing' })
      .returning({ id: schema.rebateBatches.id });
    batchId = inserted[0]!.id;
  } catch (err: any) {
    if (String(err?.message ?? '').includes('rebate_batches_cycle_month_unique')) {
      log.warn({ cycleMonth }, 'batch already exists for this cycle, aborting (no double-pay)');
      throw err;
    }
    throw err;
  }

  // 4. No recipients → record + bail out.
  if (wallets.length === 0 || pool === 0n) {
    await db.update(schema.rebateBatches).set({ status: 'no_recipients' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info({ batchId, reason: pool === 0n ? 'zero pool' : 'no wallets' }, 'no recipients');

    // Issue #360 safety net: a zero WETH pool while the Safe is actually holding
    // value means fees may have landed in a non-WETH token (CoW computes partner
    // fees in the trade's surplus token). The WETH-only pool read can't see that,
    // so this branch would otherwise no-op SILENTLY forever while value accrues.
    // Make it LOUD. Best-effort + never throws, so it can't break the recorded
    // batch result. We probe only when pool === 0n; a non-empty `wallets` set
    // with pool > 0 is the normal "recipients but..." path, not a stranding bug.
    if (pool === 0n) {
      const stranded = await getNonWethTokenBalances({ chainId: deps.chainId, safe: OPHIS_SAFE_ADDRESS, weth });
      if (stranded.length > 0) {
        // Cap the listed tokens so a dust/spam-flooded Safe can't produce a
        // message Telegram rejects (notify() only logs a non-OK send).
        const MAX_TOKENS = 12;
        const shown = stranded.slice(0, MAX_TOKENS).map((t) => `${t.symbol} ${t.balance} (${t.tokenAddress})`).join(', ');
        const detail = stranded.length > MAX_TOKENS ? `${shown}, +${stranded.length - MAX_TOKENS} more` : shown;
        log.warn({ batchId, strandedCount: stranded.length, stranded }, 'non-WETH value in Safe with zero pool');
        await alerts.alert(
          'batcher',
          `Rebate pool is 0 WETH but the Safe holds non-WETH value: ${detail}. ` +
            `Partner fees may have landed in trade tokens (Issue #360) — rebates will NOT pay until this is converted/handled.`,
        );
      }
    }

    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 5. Compute shares.
  const shares = computeShares(wallets, pool);
  const transfersAll: Transfer[] = [...shares.entries()].map(([to, amount]) => ({ to, amount }));

  // 6. Dry-run + quarantine.
  const simulate = buildEthCallSimulator({ chainId: deps.chainId, rpcUrl: deps.rpcUrl });
  const { good, bad } = await isolateBadRecipients(transfersAll, simulate);

  // 7. Write per-wallet entries (good + bad, with bad amounts zeroed).
  const entryRows = transfersAll.map((t) => {
    const w = wallets.find((x) => x.wallet === t.to)!;
    const tier = assignTier(w.volume_30d_usd);
    const isBad = bad.some((b) => b.to === t.to);
    return {
      batchId,
      wallet: t.to,
      volumeUsd: w.volume_30d_usd.toFixed(4),
      tier: tier.name,
      rebatePct: tier.rebate_pct.toFixed(4),
      wethAmountWei: isBad ? 0n : t.amount,
    };
  });
  await db.insert(schema.rebateBatchEntries).values(entryRows);

  if (good.length === 0) {
    await db.update(schema.rebateBatches).set({ status: 'failed' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.error({ batchId, badCount: bad.length }, 'all recipients quarantined');
    return { batchId, status: 'failed', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 8. Propose (unless deps.proposeEnabled is false — first-batch dry-run).
  if (!deps.proposeEnabled) {
    log.info({ batchId, recipientCount: good.length, poolWei: pool.toString() }, 'dry-run only, not proposing');
    return { batchId, status: 'computing', safeTxHash: null, recipientCount: good.length, poolWei: pool };
  }
  const { safeTxHash } = await proposeRebateBatch({
    chainId: deps.chainId,
    rpcUrl: deps.rpcUrl,
    proposerPrivateKey: deps.proposerPrivateKey,
    transfers: good,
  });
  await db.update(schema.rebateBatches).set({
    status: 'proposed',
    safeProposalHash: safeTxHash,
    proposedAt: new Date(),
  }).where(eq(schema.rebateBatches.id, batchId));

  // 9. Fire-and-forget polling for finality.
  waitForExecution({ chainId: deps.chainId, safeTxHash }).then(async (r) => {
    if (r.executed) {
      await db.update(schema.rebateBatches).set({
        status: r.isSuccessful ? 'executed' : 'failed',
        safeTxHash: r.transactionHash ?? undefined,
        executedAt: new Date(),
      }).where(eq(schema.rebateBatches.id, batchId));
    }
  }).catch((err) => log.error({ err, batchId }, 'polling failed'));

  return { batchId, status: 'proposed', safeTxHash, recipientCount: good.length, poolWei: pool };
}
