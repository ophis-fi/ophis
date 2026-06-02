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

// Telegram alerts are sent with parse_mode 'HTML' (alerter.ts). An ERC20
// `symbol` is attacker-controllable — anyone can airdrop a token with markup in
// its symbol — so escape untrusted token metadata before interpolating it.
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_ALERT_TOKENS = 12;

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

  // 1b. Issue #360 safety net — runs EVERY batcher cycle, regardless of the WETH
  //     pool. The rebate pool is WETH-only, so any value the Safe holds in OTHER
  //     tokens (CoW partner fees accrue in the trade's surplus token) is NOT
  //     distributed and accrues silently — including on a normal cycle where
  //     WETH pays out (a mixed WETH + token disbursement). Surface it loudly.
  //     The balances probe is timeout-bounded and never throws; the alert is
  //     fire-and-forget (+ its own timeout), so this can neither block nor break
  //     the payout that follows.
  try {
    const stranded = await getNonWethTokenBalances({ chainId: deps.chainId, safe: OPHIS_SAFE_ADDRESS, weth });
    if (stranded.length > 0) {
      // Cap the listed tokens so a dust/spam-flooded Safe can't produce a
      // message Telegram rejects; HTML-escape the (attacker-controllable) token
      // metadata since notify() sends with parse_mode 'HTML'.
      const shown = stranded
        .slice(0, MAX_ALERT_TOKENS)
        .map((t) => `${escapeHtml(t.symbol)} ${t.balance} (${escapeHtml(t.tokenAddress)})`)
        .join(', ');
      const detail = stranded.length > MAX_ALERT_TOKENS ? `${shown}, +${stranded.length - MAX_ALERT_TOKENS} more` : shown;
      log.warn({ strandedCount: stranded.length, stranded, poolWei: pool.toString() }, 'non-WETH value in Safe, not covered by WETH-only pool');
      // Fire-and-forget: a (bounded) Telegram send must not delay the payout.
      void alerts
        .alert(
          'batcher',
          `Safe holds non-WETH value NOT included in the WETH-only rebate pool: ${detail}. ` +
            `Partner fees may accrue in trade tokens (Issue #360); ` +
            (pool === 0n
              ? `the pool is 0 WETH so rebates will NOT pay this cycle until handled.`
              : `the WETH payout proceeds but this value is excluded and will accrue until converted/handled.`),
        )
        .catch((err) => log.warn({ err }, 'stranded-fee alert send failed'));
    }
  } catch (err) {
    log.warn({ err }, 'stranded-fee probe failed (ignored)');
  }

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

  // 4. No recipients → record + bail out. (The stranded non-WETH probe ran in
  //    step 1b, regardless of pool, so a zero-pool cycle is already alerted.)
  if (wallets.length === 0 || pool === 0n) {
    await db.update(schema.rebateBatches).set({ status: 'no_recipients' })
      .where(eq(schema.rebateBatches.id, batchId));
    log.info({ batchId, reason: pool === 0n ? 'zero pool' : 'no wallets' }, 'no recipients');
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
