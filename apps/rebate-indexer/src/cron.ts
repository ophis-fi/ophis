import { runFetcher, pruneStaleWallets, withPipelineLock } from './fetcher.js';
import { repairRouterTrades } from './repair/routerTrades.js';
import { repairDefiLlamaSettlementIdentity } from './repair/defillamaSettlement.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth, bootstrapFeeConversion } from './batcher.js';
import { reconcileBatches } from './batch/reconcile.js';
import { deliverMonthlyReport } from './affiliate/deliverReport.js';
import { runAffiliatePayout, reconcileAffiliateBatches } from './affiliate/payout.js';
import { resolveAffiliatePayoutEnabled } from './affiliate/payoutPlan.js';
import { OWN_FEE_GUARANTEED_CHAIN_IDS } from './affiliate/rates.js';
import { accrueOwnFee, proposeOwnFeeBatches, reconcileOwnFeeBatches } from './ownFee/payout.js';
import { resolveOwnFeePayoutEnabled } from './ownFee/payoutPlan.js';
import { runPartnerFeeFetch } from './partnerFees/fetch.js';
import { runPartnerFeePricer } from './partnerFees/pricePartnerFees.js';
import { accruePartnerFees, proposePartnerFeeBatches, reconcilePartnerFeeBatches, resolvePartnerFeePayoutEnabled } from './partnerFees/payout.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';
import { completeDefiLlamaBackfillIfReady } from './defillamaBackfill.js';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
}

// Sovereign chains that pay per-recipient own-fee (each from its OWN chain's Ophis Safe).
const SOVEREIGN_OWN_FEE_CHAINS = [...OWN_FEE_GUARANTEED_CHAIN_IDS];
// Keyless public defaults; override per chain via OWN_FEE_RPC_URL_<id> (or the existing
// SETTLE_RPC_URL_<id> the settle decoder already uses).
const SOVEREIGN_RPC_DEFAULT: Record<number, string> = {
  10: 'https://mainnet.optimism.io',
  130: 'https://mainnet.unichain.org',
};
function ownFeeRpc(chainId: number): string {
  return (
    process.env[`OWN_FEE_RPC_URL_${chainId}`] ??
    process.env[`SETTLE_RPC_URL_${chainId}`] ??
    SOVEREIGN_RPC_DEFAULT[chainId] ??
    'https://mainnet.optimism.io'
  );
}

/**
 * Global dry-run switch for the monthly Safe proposals (rebate batcher, affiliate
 * payout, own-fee proposal). Default-ON (unset/''/'true'/'1' => propose) so live
 * behavior is unchanged; 'false'/'0' => dry-run only. Any OTHER value THROWS
 * (fail-loud) instead of silently proposing, so a typo like 'False'/'no'/'off'
 * can never be misread as "propose real money". Same fail-loud parser shape as
 * resolveDirectMode/resolveAffiliatePayoutEnabled/resolveOwnFeePayoutEnabled — this
 * one just defaults ON rather than OFF. A money-path flag must never fail OPEN on an
 * ambiguous value.
 */
export function resolveBatcherProposeEnabled(): boolean {
  const raw = process.env.BATCHER_PROPOSE_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`BATCHER_PROPOSE_ENABLED must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

/**
 * True when THIS calendar month's batcher step already completed: the heartbeat writes a
 * first_of_month=true pipeline_runs row ONLY when runBatcher actually executed (any result),
 * never on a skip/fail-closed cycle -- which is exactly what makes it a retry gate.
 */
export async function batcherRanThisMonth(servicedBoundary: Date): Promise<boolean> {
  // Scoped to the SERVICED boundary's month, not wall-clock now(). At 01:50 on the
  // 1st a catch-up run services the PREVIOUS month's final boundary; asking about
  // now()'s month would find no first_of_month row yet and wrongly report the
  // monthly step as "missing", dragging the irreversible payout section into a run
  // that belongs to last month. See the monthlyDue note below.
  // Match on serviced_boundary WITHIN the month, not on ran_at, and bound it at both
  // ends. ran_at is a completion stamp with no upper bound, so a September monthly
  // run that catches up shortly before 02:00 on October 1 lands a first_of_month row
  // stamped in October while having serviced September 30. If October's own attempt
  // then fails, the October 2 catch-up would read that September row as proof that
  // October's batcher ran and skip the monthly section for the rest of the month.
  //
  // ⚠️ Both sides are pinned to UTC wall time. date_trunc('month', <timestamptz>) uses
  // the SESSION timezone, and our boundaries are 02:00 UTC -- which under a negative
  // offset is the PREVIOUS day locally. Measured on postgres:16-alpine:
  //     SET TIME ZONE 'America/New_York';
  //     date_trunc('month','2026-09-01T02:00:00Z'::timestamptz)  ->  2026-08-01
  // i.e. the September gate would silently be evaluated against AUGUST, on the money
  // path. The container default is UTC today, so this is latent rather than live --
  // but a PGTZ env var or an image change would flip it with no other symptom.
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM pipeline_runs
       WHERE first_of_month
         AND (serviced_boundary AT TIME ZONE 'UTC') >= date_trunc('month', ${servicedBoundary.toISOString()}::timestamptz AT TIME ZONE 'UTC')
         AND (serviced_boundary AT TIME ZONE 'UTC') <  date_trunc('month', ${servicedBoundary.toISOString()}::timestamptz AT TIME ZONE 'UTC') + interval '1 month'
    ) AS ok
  `;
  return row?.ok ?? false;
}

/**
 * The full nightly pipeline. Runs sequentially. Called by the daily cron tick.
 * On the 1st of the month, batcher runs as the final step — never as a separate
 * cron entry, eliminating the race noted in the spec §"Safe batch flow → Step 1".
 */
// The actual pipeline steps. Always invoked via runNightlyPipeline (under the
// pipeline advisory lock); never call this directly or you reintroduce the race
// with the startup backfill.
async function runPipelineSteps(servicedBoundary: Date): Promise<void> {
  // BOUNDARY-COMPLETE, not "stale by 6 hours". With an intraday refresh running,
  // the 01:00 tick has just stamped last_fetched on every wallet, so the old 6h
  // default would make the nightly SKIP them -- and a trade settling between that
  // refresh and 02:00 would be missing when the first-of-month batcher reads the
  // wallets view and computes an IRREVERSIBLE payout. `now` makes every wallet
  // eligible exactly once here.
  const { inserted } = await runFetcher(undefined, { staleBefore: new Date() });
  log.info({ inserted }, 'fetcher complete');

  // Registry maintenance — nightly only (never inside runFetcher / the replay
  // loop). Evicts spam wallets that will never yield a rebate; keeps proven
  // wallets and any still being retried.
  const { pruned } = await pruneStaleWallets();
  log.info({ pruned }, 'prune complete');

  // Self-healing repair for router-attributed trades (see repair/routerTrades.ts).
  // Placed BEFORE the pricer + backfill-readiness check so the queue cleanup can
  // unstick the /defillama gate the same night, and before the scorer so the
  // matview refresh picks up re-attributed wallets. Idempotent no-op once clean.
  // Wrapped: a CoW/API hiccup here must not break the money pipeline behind it
  // (skipped rows are already excluded from every public surface and the payout
  // gate, so a failed repair run costs nothing and retries tomorrow).
  try {
    const routerRepair = await repairRouterTrades();
    if (routerRepair.scanned > 0 || routerRepair.dequeued > 0) {
      log.info(routerRepair, 'router repair complete');
    }
  } catch (err) {
    log.error({ err }, 'router repair failed (pipeline continues)');
  }

  // Recover DefiLlama settlement transaction/user identity from immutable Trade
  // logs and reconstruct any verified aggregate trade that predates the fill
  // ledger. This is reporting-only and never changes rebate accrual fields.
  try {
    const reportingRepair = await repairDefiLlamaSettlementIdentity();
    if (reportingRepair.identities > 0 || reportingRepair.fills > 0 || reportingRepair.fees > 0 || reportingRepair.failedBlocks > 0) {
      log.info(reportingRepair, 'DefiLlama settlement repair complete');
    }
  } catch (err) {
    log.error({ err }, 'DefiLlama settlement repair failed (reporting remains fail-closed)');
  }

  const priced = await runPricer();
  log.info(priced, 'pricer complete');
  await completeDefiLlamaBackfillIfReady();

  const scored = await runScorer();
  log.info(scored, 'scorer complete');

  // Partner-fee accrual feed (partner-fees Phase B): pull new fee-bearing trades from the
  // restricted feed and price their collected fee. Nightly, like the main pricer; the monthly
  // batcher (below) consumes the priced trades. Wrapped so a restricted-feed / pricing outage
  // never breaks the main pipeline (the feature is inert until PARTNER_FEE_FEED_URLS is set).
  // BUT the failure is NOT swallowed for money purposes: partnerFeedOk feeds the 1st-of-month
  // fail-closed guard below -- a feed the fetcher could not drain (or rows the pricer left
  // unpriced) means the partner liability would silently UNDER-count, and the shared-Safe
  // rebate/affiliate distribution must not run against it. (Accrual itself also fail-louds on
  // in-scope unpriced/un-timestamped rows, which covers backlogs from earlier nights.)
  let partnerFeedOk = true;
  try {
    const pf = await runPartnerFeeFetch();
    const pfp = await runPartnerFeePricer();
    if (pfp.failed > 0) {
      partnerFeedOk = false;
      log.error({ priceFailed: pfp.failed }, 'partner-fee pricer left rows unpriced; the 1st-of-month shared-Safe distribution fails closed until they price');
    }
    // A SKIPPED (ambiguous) attribution is dropped fees for real partners on that row -- the
    // cursor advances past it, so no later query can see the absence. Tonight's skips fail the
    // cycle closed like unpriced rows do; a mid-month skip is surfaced by the fetch-time capped
    // alert and MUST be resolved (re-cursor or manual accounting) before month-end -- it cannot
    // be re-detected here once its night has passed.
    if (pf.skipped > 0) {
      partnerFeedOk = false;
      log.error({ skipped: pf.skipped }, 'partner-fee fetch skipped ambiguous attributions; the 1st-of-month shared-Safe distribution fails closed (fees dropped from the feed)');
    }
    // A page-capped run drained only a PREFIX of the feed: accruing it would under-count the
    // liability exactly like unpriced rows would. Fails the cycle closed; the fetch resumes
    // from its cursor next night and the (retried) monthly section completes once drained.
    if (pf.capped) {
      partnerFeedOk = false;
      log.error('partner-fee fetch hit its per-run page cap with pages remaining; the 1st-of-month shared-Safe distribution fails closed until the feed drains');
    }
    // Feeds unset AFTER the program was active = misconfiguration: new partner settlements
    // would be entirely absent from the DB, invisible to the accrual completeness gate.
    if (pf.misconfigured) {
      partnerFeedOk = false;
      log.error('PARTNER_FEE_FEED_URLS is empty but the partner-fee program has been active; fail-closed until the feed config is restored');
      await alerts.alert('partner-fee', 'PARTNER_FEE_FEED_URLS is EMPTY but partner-fee cursor rows exist (the program was active). Fail-closed: the shared-Safe distribution is blocked until the feed config is restored.').catch(() => {});
    }
    // An anomalous (over-cap) fee valuation was quarantined unpriced -- same fail-closed
    // posture as a pricing failure until the operator investigates.
    if (pfp.anomalous > 0) {
      partnerFeedOk = false;
      log.error({ anomalous: pfp.anomalous }, 'partner-fee pricer quarantined anomalous valuation(s); the shared-Safe distribution fails closed pending investigation');
    }
    log.info({ fetched: pf.inserted, skipped: pf.skipped, priced: pfp.priced, priceFailed: pfp.failed }, 'partner-fee fetch+price complete');
  } catch (err) {
    partnerFeedOk = false;
    log.error({ err }, 'partner-fee fetch/price failed (non-fatal to the rest of the pipeline; the 1st-of-month shared-Safe distribution fails closed)');
  }

  // tierer.ts has no batch refresh — it's read-on-demand. Nothing to call here.

  // Reconcile open Safe batches EVERY night (independent of the 1st-of-month
  // batcher): heals 'proposed' rows whose in-process execution poller was lost to
  // a restart, nags unsigned batches, and surfaces stuck 'proposing' rows. It only
  // READS the Safe service + writes terminal status/alerts — it never proposes or
  // pays — so a failure here is non-fatal and must NOT abort the pipeline or block
  // the batcher below. (Runs before the batcher so last cycle is closed out first.)
  try {
    const rec = await reconcileBatches({ chainId: 100 });
    log.info(rec, 'reconcile complete');
    // Same nightly heal for affiliate batches (separate table, same Safe service).
    const arec = await reconcileAffiliateBatches({ chainId: 100 });
    log.info(arec, 'affiliate reconcile complete');
    // Same nightly heal for sovereign own-fee batches (separate table; each row polls
    // the Safe service on its OWN chain 10/130). Read-only, so also safe to run always.
    const ofrec = await reconcileOwnFeeBatches({});
    log.info(ofrec, 'own-fee reconcile complete');
    // Same nightly heal for partner-fee batches (separate table, same Gnosis Safe service).
    const pfrec = await reconcilePartnerFeeBatches({});
    log.info(pfrec, 'partner-fee reconcile complete');
  } catch (err) {
    log.error({ err }, 'reconcile failed (non-fatal; observability only)');
    await alerts.alert('reconcile', `Nightly batch reconciliation failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }

  // Telegram summary.
  const newTradesRows = await sql<{ new_trades: string }[]>`
    SELECT COUNT(*)::text AS new_trades FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
  `;
  const volumeRows = await sql<{ volume: string | null }[]>`
    SELECT COALESCE(SUM(value_usd)::text, '0') AS volume FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
  `;
  const new_trades = newTradesRows[0]?.new_trades ?? '0';
  const volume = volumeRows[0]?.volume ?? '0';
  await alerts.nightlyComplete({ newTrades: parseInt(new_trades, 10), volumeUsd: parseFloat(volume ?? '0') });

  // Tracks whether the monthly batcher STEP actually executed this run — NOT
  // merely that it is the 1st. A skipped batcher (e.g. missing proposer key)
  // must NOT advance /health.last_batcher_run_at, or the signal would claim the
  // batcher ticked while masking the very missed batch it exists to expose.
  let batcherRan = false;
  // Hoisted out of the first-of-month block: the NIGHTLY partner-fee proposal retry (below)
  // gates on it too. On non-1st days it stays true (no accrual ran to invalidate it).
  let partnerAccrualOk = true;
  // The monthly section runs on the 1st -- OR on any later night while THIS month's batcher
  // step has not yet completed (no first_of_month=true pipeline_runs row this month). That
  // row is written ONLY when runBatcher actually executed, so a 1st that failed closed (feed
  // outage), was skipped (lock contention, missing key), or never ran (host down) is RETRIED
  // the next night instead of silently deferring the whole shared-Safe cycle a month. Every
  // step inside is cycle-idempotent: accruals re-run while 'computed', runBatcher resumes or
  // aborts an already-proposed cycle, and proposals fire at most once per batch.
  // ⚠️ MONEY PATH — both operands MUST derive from servicedBoundary, never the wall
  // clock. The monthly section accrues and PROPOSES Safe batches and is deliberately
  // irreversible (runBatcher aborts an already-proposed cycle rather than recomputing
  // it). Since 2026-08-31 the scheduler polls, so a catch-up run can execute at, say,
  // 01:50 on the 1st while servicing the PREVIOUS day's boundary. Gating on
  // wall-clock isFirstOfMonth() there would propose the new month's cycle before its
  // boundary and before the fetcher ingested the final pre-boundary data — and it
  // could not be undone. Gate on the boundary the run is actually servicing.
  // ⚠️ EVERY helper inside this block that selects a CYCLE must be given
  // servicedBoundary as its `now`. They all default to the wall clock, and the
  // catch-up operand can make monthlyDue true while servicing a boundary in a
  // DIFFERENT month -- which is live right now, since pipeline_runs is empty in
  // production. Mixing them means runBatcher settles August while accrueOwnFee /
  // accruePartnerFees / runAffiliatePayout / deliverMonthlyReport settle September.
  // proposeOwnFeeBatches and proposePartnerFeeBatches are exempt: they act on
  // already-computed batch rows by state, and select no cycle.
  const monthlyDue = isFirstOfMonth(servicedBoundary) || !(await batcherRanThisMonth(servicedBoundary));
  if (monthlyDue) {
    if (!isFirstOfMonth(servicedBoundary)) log.warn('monthly batcher step missing for this month; running CATCH-UP monthly section tonight');
    log.info('first-of-month: running batcher');
    // Sovereign own-fee ACCRUAL (phase A). Runs FIRST, flag-INDEPENDENT and proposer-key
    // -INDEPENDENT: it records the owed ledger to a 'computed' batch per sovereign chain
    // (10/130) so nothing is ever lost while the payout flag or the proposer key are off.
    // It reads no Safe balance and proposes nothing. Kept outside the proposer-key branch
    // (a missing key must not skip accrual) and before the batcher so the current cycle's
    // batch already exists for a same-run proposal. Wrapped per chain so one failure never
    // blocks the rest of the cycle.
    for (const chainId of SOVEREIGN_OWN_FEE_CHAINS) {
      try {
        await accrueOwnFee({ chainId, now: servicedBoundary });
      } catch (err) {
        log.error({ err, chainId }, 'own-fee accrual failed (non-fatal to the rest of the cycle)');
      }
    }
    // Partner-fee ACCRUAL (partner-fees Phase B) — MUST run FIRST, BEFORE the rebate batcher
    // and affiliate payout (money-correctness): it records this cycle's partner-owed ledger,
    // which is the outstanding liability those two batchers SUBTRACT to avoid paying the same
    // WETH twice. Flag- AND proposer-key-INDEPENDENT (records the ledger regardless). If it
    // THROWS, we FAIL CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle,
    // because both distribute the SAME Ophis Safe and, without an up-to-date partner liability,
    // could pay out WETH owed to partners. Own-fee (a separate sovereign Safe) is unaffected.
    // The guard covers the WHOLE ingestion->accrual chain, not just accruePartnerFees: a feed
    // the fetcher could not drain tonight means trades may be MISSING entirely (undetectable
    // by accrual), so partnerFeedOk fails the cycle closed too. Accrual still RUNS on a bad
    // feed night -- it records what is known, is idempotent while 'computed', and a pipeline
    // re-trigger after the feed heals re-accrues the full month before anything distributes.
    partnerAccrualOk = partnerFeedOk;
    if (!partnerFeedOk) {
      log.error('partner-fee feed/pricing incomplete on the 1st; fail-closed: SKIPPING the rebate batcher + affiliate payout this cycle');
      await alerts.alert('partner-fee', 'Partner-fee feed fetch/pricing INCOMPLETE on the 1st. FAIL-CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle (the partner liability could under-count missing/unpriced trades). Fix the feed/pricer and re-trigger the pipeline.').catch(() => {});
    }
    try {
      await accruePartnerFees({ now: servicedBoundary });
    } catch (err) {
      partnerAccrualOk = false;
      log.error({ err }, 'partner-fee accrual FAILED; fail-closed: SKIPPING the rebate batcher + affiliate payout this cycle (shared Safe must not be distributed against a stale/absent partner liability)');
      await alerts.alert('partner-fee', 'Partner-fee accrual FAILED on the 1st. FAIL-CLOSED: the rebate batcher AND affiliate payout are SKIPPED this cycle (they share the Ophis Safe and could otherwise spend WETH owed to partners against a stale/absent liability). Fix accrual and re-trigger the pipeline.').catch(() => {});
    }
    const proposeEnabled = resolveBatcherProposeEnabled();
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (!proposerKey) {
      log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping batcher');
      await alerts.alert('batcher', 'SAFE_PROPOSER_PRIVATE_KEY env var missing — no proposal made');
    } else {
      // Shared-Safe distribution (rebate + affiliate) runs ONLY when partner accrual
      // succeeded (fail-closed): both draw from the same Ophis Safe and must never distribute
      // it against a stale/absent partner liability.
      if (partnerAccrualOk) {
        const result = await runBatcher({
          chainId: 100,
          rpcUrl: gnosisRpc(),
          proposerPrivateKey: proposerKey as `0x${string}`,
          proposeEnabled,
        }, servicedBoundary); // cycleMonthKey from the SERVICED boundary, not wall clock
        batcherRan = true; // batcher executed (any result: proposed / no_recipients / dry-run)
        if (result.status === 'proposed') {
          await alerts.batchReady({
            cycle: servicedBoundary.toISOString().slice(0, 7),
            pool: (Number(result.poolWei) / 1e18).toFixed(5),
            count: result.recipientCount,
            safeQueueUrl: 'https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
            topRecipient: 'see /batches/' + result.batchId,
          });
        }
        // Affiliate payout: runs AFTER the rebate batcher (it reads this cycle's
        // rebate pool for the double-spend guard) and is independently flag-gated
        // (AFFILIATE_PAYOUT_ENABLED, default OFF). A separate Safe MultiSend at the
        // next free nonce; execution still needs the 2-of-3 signature. Wrapped so a
        // payout failure never blocks the report or the heartbeat.
        if (resolveAffiliatePayoutEnabled()) {
          try {
            await runAffiliatePayout({ chainId: 100, rpcUrl: gnosisRpc(), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled, now: servicedBoundary });
          } catch (err) {
            log.error({ err }, 'affiliate payout failed (non-fatal to the rest of the cycle)');
          }
        }
      } else {
        log.error('skipping rebate batcher + affiliate payout this cycle: partner accrual failed (fail-closed, shared Safe)');
      }
      // Sovereign per-recipient own-fee PROPOSAL (phase B). Needs the proposer key
      // (this branch) AND OWN_FEE_PAYOUT_ENABLED (default OFF). Accrual (phase A) ran
      // above, flag- and key-independent, so the current cycle's 'computed' batch
      // already exists here. Proposes EVERY un-proposed 'computed' batch (current cycle
      // AND any back-months a previously-off flag/key left behind), each a SEPARATE Safe
      // MultiSend on ITS OWN sovereign chain from that chain's Ophis Safe; execution
      // still needs the 2-of-3 signature. Wrapped per chain so one failure never blocks
      // the other, the report, or the heartbeat.
      if (resolveOwnFeePayoutEnabled()) {
        for (const chainId of SOVEREIGN_OWN_FEE_CHAINS) {
          try {
            await proposeOwnFeeBatches({ chainId, rpcUrl: ownFeeRpc(chainId), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled });
          } catch (err) {
            log.error({ err, chainId }, 'own-fee proposal failed (non-fatal to the rest of the cycle)');
          }
        }
      }
    }
    // Monthly settlement report — runs AFTER the batcher + affiliate payout so it
    // reflects this cycle's numbers. Self-contained + fire-and-forget (alerts on
    // failure, never throws), so a report hiccup can never block the heartbeat below.
    await deliverMonthlyReport({ rpcUrl: gnosisRpc(), now: servicedBoundary });
  }

  // Partner-fee PROPOSAL (partner-fees Phase B) — NIGHTLY, not first-of-month-only. Needs
  // PARTNER_FEE_PAYOUT_ENABLED (default OFF) + the proposer key. proposePartnerFeeBatches
  // proposes EVERY un-proposed 'computed' batch (each at most once), so a batch left behind by
  // an underfunded Safe, a transient pre-submit failure, an ambiguous-submission stop, or a
  // flag flipped mid-month is retried the NEXT NIGHT instead of waiting for the next 1st.
  // ACCRUAL stays monthly (above). Gated on partnerAccrualOk so the 1st never proposes against
  // a failed/incomplete accrual; on other nights it is trivially true. Its over-draw guard
  // reserves the already-queued rebate/affiliate proposals, the mirror of their reservation of
  // the partner liability. Wrapped so a failure never blocks the heartbeat. (On the 1st this
  // runs after deliverMonthlyReport; the report reads point-in-time stats, so ordering is
  // cosmetic.)
  if (partnerAccrualOk && resolvePartnerFeePayoutEnabled()) {
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (!proposerKey) {
      log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping the nightly partner-fee proposal');
      await alerts.alert('partner-fee', 'PARTNER_FEE_PAYOUT_ENABLED is on but SAFE_PROPOSER_PRIVATE_KEY is missing — no partner-fee proposal made.').catch(() => {});
    } else {
      try {
        await proposePartnerFeeBatches({ rpcUrl: gnosisRpc(), proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled: resolveBatcherProposeEnabled() });
      } catch (err) {
        log.error({ err }, 'partner-fee proposal failed (non-fatal; retried next night)');
      }
    }
  }

  // Fee-conversion BOOTSTRAP — last, deliberately.
  //
  // The rebate pool reads the Safe's WETH balance on Gnosis, but CoW pays partner
  // fees out in the chain's NATIVE coin, so the pool reads 0, so no payout is
  // proposed, so the payout-gated #360 conversion never runs, so the pool stays 0.
  // No rebate has ever paid because of that loop. bootstrapFeeConversion breaks it
  // by proposing a conversion with no payout above it.
  //
  // It runs HERE, after every other proposal, because its safety gate is "the Safe
  // queue is empty". Checked earlier that gate is worthless: the affiliate payout and
  // the partner-fee proposal above would stack on top of the nonce it took, and an
  // unsigned bootstrap would block both — the Codex #474 hazard by another route. On
  // any night something else is queued this is a no-op and retries tomorrow.
  //
  // Gated by REBATE_CONVERT_ENABLED (default OFF) inside maybeConvertFeesToWeth, so
  // this is byte-inert until an operator turns it on. Never throws.
  {
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
    if (proposerKey) {
      try {
        await bootstrapFeeConversion({
          chainId: 100,
          rpcUrl: gnosisRpc(),
          proposerPrivateKey: proposerKey as `0x${string}`,
          proposeEnabled: resolveBatcherProposeEnabled(),
        });
      } catch (err) {
        log.error({ err }, 'fee-conversion bootstrap failed (non-fatal; retried next night)');
      }
    }
  }

  // Durable nightly-completion heartbeat — LAST, so a row means the whole
  // pipeline ran to completion. Written only here (the cron path), never by the
  // startup backfill, so /health can witness the 02:00 UTC tick without the
  // admin-gated /status and a redeploy can't clobber it. The first_of_month
  // column is set ONLY when the batcher STEP actually ran (batcherRan), so
  // /health.last_batcher_run_at reflects real batcher executions, not skips.
  // serviced_boundary records WHICH nightly this run was for, taken at tick time.
  // Inferring it from ran_at (the completion stamp) lets a run that crosses 02:00
  // satisfy two boundaries and silently skip a day -- see migration 0043.
  await recordPipelineRun(batcherRan, servicedBoundary);
}

/**
 * Write the nightly heartbeat row. Exported as a SEAM so an integration test can
 * execute the real INSERT against Postgres -- binding a Date here (rather than an
 * ISO string) is what broke production on 2026-08-31, and no unit test can catch it
 * because nothing else executes this SQL.
 */
export async function recordPipelineRun(batcherRan: boolean, servicedBoundary: Date): Promise<void> {
  await sql`INSERT INTO pipeline_runs (first_of_month, serviced_boundary) VALUES (${batcherRan}, ${servicedBoundary.toISOString()}::timestamptz)`;
}

export async function runNightlyPipeline(
  // Defaults to the current boundary so manual/CLI/test invocations stay ergonomic.
  // nightlyTick ALWAYS passes it explicitly, computed once at tick time — that is
  // what stops a run crossing 02:00 from being recorded against the wrong boundary.
  servicedBoundary: Date = lastNightlyBoundary(Date.now()),
): Promise<void> {
  const t0 = Date.now();
  log.info('pipeline start');

  try {
    // Hold the pipeline lock for the whole run so the non-blocking startup
    // backfill (index.ts) can't run concurrently and leave the batcher reading a
    // half-updated `wallets` matview on the 1st.
    // Unlike optional startup/reward passes, the only daily refresh must never
    // disappear because a five-minute reward tick owned the lock at 02:00.
    // Queue behind active work; later reward ticks use try-lock and defer.
    //
    // The wait is BOUNDED (see withPipelineLock), so this can still return false
    // if a holder wedges for 15 minutes. That outcome must stay LOUD: it is the
    // same "the nightly run did not happen" condition the pre-wait code alerted
    // on, and on the 1st it defers the monthly Safe proposal. Dropping the alert
    // along with the skip path would make the one case we cannot fix silent.
    const ran = await withPipelineLock(() => runPipelineSteps(servicedBoundary), { wait: true });
    if (!ran) {
      log.error('nightly pipeline did not run — waited out the pipeline lock');
      const monthly = isFirstOfMonth(servicedBoundary)
        ? ' This is the 1st: the monthly rebate batch may be deferred — verify the Safe queue or re-trigger.'
        : '';
      // A manual re-trigger is safe and recovers a stuck cycle: runBatcher RESUMES
      // a 'computing'/'failed' row that never proposed, and ABORTS (no double-pay)
      // if the cycle was already proposed/terminal.
      await alerts.alert(
        'batcher',
        `Nightly pipeline did not run: another pipeline run held the lock for the full wait window.${monthly}`,
      );
    }
  } catch (err: any) {
    log.error({ err: err?.message ?? err }, 'pipeline failed');
    await alerts.alert('pipeline', String(err?.message ?? err));
    throw err;
  }
  log.info({ ms: Date.now() - t0 }, 'pipeline complete');
}

/**
 * Most recent 02:00 UTC boundary at or before `nowMs`.
 * Pure — testable without a clock or a database.
 */
export function lastNightlyBoundary(nowMs: number): Date {
  const DAY = 86_400_000;
  const OFFSET = 2 * 3_600_000; // 02:00 UTC
  return new Date(Math.floor((nowMs - OFFSET) / DAY) * DAY + OFFSET);
}

const NIGHTLY_POLL_MS = 10 * 60 * 1_000;
const NIGHTLY_RETRY_MS = 60 * 60 * 1_000;
// RETRY THROTTLE ONLY — deliberately not a mutex. It is a plain module-level
// timestamp, so two ticks could in principle read it before either writes. That is
// fine: mutual exclusion is enforced where it matters, by the pg ADVISORY LOCK in
// withPipelineLock (which the startup backfill in index.ts also takes), so pipeline
// STEPS can never interleave. The worst case here is one redundant sequential run,
// because `due` is not re-checked once the lock is acquired. Do not "harden" this
// into a lock — it would duplicate the advisory lock and add a second thing to wedge.
let lastNightlyAttempt = 0;
// Timestamp, NOT a boolean. A boolean in-flight flag is unbounded: runNightlyPipeline
// has no overall timeout and the Safe SDK (@safe-global/api-kit -> node-fetch@2) issues
// requests with no timeout at all, so one wedged Safe/DB/RPC call would pin the flag and
// suppress EVERY future tick until someone restarted the container -- reintroducing, in a
// new shape, the exact "the nightly silently never runs again" bug this file exists to fix.
// Bounded instead: after NIGHTLY_MAX_RUNTIME_MS we stop suppressing and say so loudly.
// This is safe because the flag was never the mutex -- the pg advisory lock in
// withPipelineLock is, and its wait is bounded, so a genuinely wedged holder produces a
// LOUD "did not run" alert rather than silence.
let nightlyStartedAt = 0; // 0 = no run in flight
const NIGHTLY_MAX_RUNTIME_MS = 6 * 60 * 60 * 1_000;

/**
 * Is a nightly run due for `boundary`? Reads the DURABLE completion record.
 * Exported as a SEAM so an integration test can execute the real query -- see
 * recordPipelineRun for why that matters.
 */
export async function isNightlyDue(boundary: Date): Promise<boolean> {
  const [row] = await sql<{ due: boolean }[]>`
    SELECT COALESCE(MAX(serviced_boundary), '-infinity'::timestamptz) < ${boundary.toISOString()}::timestamptz AS due
    FROM pipeline_runs
  `;
  return row?.due === true;
}

/**
 * Decide whether the nightly pipeline is due, from the DURABLE completion record
 * rather than from a timer having fired at the right instant.
 *
 * WHY NOT node-cron (removed 2026-08-31): node-cron@4 arms a timer for the target
 * instant and, if that timer lands outside the target SECOND, it logs
 * "missed execution at ..." and DOES NOT RUN THE JOB. Cadia is Windows 11 + WSL2 and
 * suspends, so the timer thaws minutes-to-hours late and every night was skipped.
 * PROVEN on the host 2026-08-31: `grep -c 'pipeline start'` returned 0 across 35h of
 * uptime, alongside
 *   [NODE-CRON] [WARN] missed execution at Mon Aug 31 2026 02:00:00 GMT+0000!
 * so `pipeline_runs` was empty and /health.last_pipeline_run_at had been null since the
 * table was added. The ONLY thing refreshing public data was the startup backfill that
 * runs on each container recreate, i.e. every deploy — which masked it for weeks.
 *
 * A poll fixes the whole class, not just the suspend case: it is equally correct if the
 * process was down at 02:00, if the lock was held, or if a run threw. Being late is
 * always better than being skipped for a daily job.
 */
async function nightlyTick(): Promise<void> {
  // A real nightly run can exceed NIGHTLY_RETRY_MS (the 1st-of-month cycle does
  // Safe proposals and reconciliation). Without this flag the elapsed-time guard
  // would let a second tick start while the first is still running; it would then
  // lose NIGHTLY_PENDING_LOCK_KEY in withPipelineLock, log 'another nightly
  // pipeline run is already pending', and return false for no reason. Skip instead.
  if (nightlyStartedAt) {
    const running = Date.now() - nightlyStartedAt;
    if (running < NIGHTLY_MAX_RUNTIME_MS) return;
    log.error(
      { runningMs: running, maxMs: NIGHTLY_MAX_RUNTIME_MS },
      'previous nightly run has been in flight past the max runtime - it is presumed wedged (the Safe SDK has no request timeout). Releasing the in-flight guard so ticks resume; the pipeline advisory lock still prevents true concurrency and will alert if the old run still holds it.',
    );
    nightlyStartedAt = 0;
  }
  if (Date.now() - lastNightlyAttempt < NIGHTLY_RETRY_MS) return;
  // Compute the boundary ONCE and carry it through the whole invocation, so the run
  // is recorded against the boundary it was started for rather than whenever it
  // happened to finish.
  const boundary = lastNightlyBoundary(Date.now());
  // ⚠️ .toISOString() + an EXPLICIT ::timestamptz cast on every boundary parameter.
  // Binding a raw Date here threw on EVERY tick in production (2026-08-31 18:35 deploy):
  //   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
  //   ... Received an instance of Date   at Buffer.byteLength -> postgres/src/bytes.js
  // postgres.js resolved this parameter's type as text (the comparison gives PG nothing
  // to infer timestamptz from), then tried to serialise a Date as a string and crashed
  // at Bind. The tick threw, was swallowed by its .catch, and the nightly never ran --
  // silently, for 3h20m, exactly the failure this whole change exists to remove.
  // An ISO string with an explicit cast is unambiguous to both the driver and PG.
  if (!(await isNightlyDue(boundary))) return;
  lastNightlyAttempt = Date.now();
  nightlyStartedAt = Date.now();
  try {
    await runNightlyPipeline(boundary).catch(() => { /* already logged + alerted */ });
  } finally {
    nightlyStartedAt = 0;
  }
}

/**
 * Intraday refresh cadence, in minutes. Default 60.
 *
 * The 02:00 nightly is untouched and still owns registry maintenance, repairs,
 * partner fees, reconciliation, accrual, the batcher and the monthly report.
 * This lighter tick exists only so the PUBLIC surface stops being up to 24h
 * behind.
 *
 * COST NOTE: runFetcher pages the CoW API per (chain, owner) with
 * FETCHER_MAX_OWNERS_PER_RUN = 500, so with 13 production chains and ~29 tracked
 * wallets one pass is roughly 380 calls -- about 9k/day at 60 minutes.
 */
export function refreshIntervalMs(): number {
  const raw = process.env['REBATES_REFRESH_MINUTES'];
  const mins = raw === undefined ? 60 : Number(raw);
  // Reject junk, and anything under 10 minutes: the poll loop ticks every 10, so
  // a smaller boundary is unreachable and would merely look broken.
  if (!Number.isFinite(mins) || mins < 10 || mins > 24 * 60) return 60 * 60_000;
  return Math.floor(mins) * 60_000;
}

/** Most recent refresh boundary at or before `nowMs`. Pure. */
export function lastRefreshBoundary(nowMs: number, intervalMs: number): Date {
  return new Date(Math.floor(nowMs / intervalMs) * intervalMs);
}

/** Is an intraday refresh due? Reads the DURABLE record, never a timer. */
export async function isRefreshDue(boundary: Date): Promise<boolean> {
  const [row] = await sql<{ due: boolean }[]>`
    SELECT COALESCE(MAX(serviced_boundary), '-infinity'::timestamptz) < ${boundary.toISOString()}::timestamptz AS due
    FROM refresh_runs
  `;
  return row?.due === true;
}

export async function recordRefreshRun(servicedBoundary: Date): Promise<void> {
  await sql`INSERT INTO refresh_runs (serviced_boundary) VALUES (${servicedBoundary.toISOString()}::timestamptz)`;
}

/**
 * The light path: bring the PUBLIC surface up to date and nothing else.
 *
 * Deliberately excludes every step runPipelineSteps marks nightly-only --
 * pruneStaleWallets ("Registry maintenance — nightly only"), the repairs,
 * DefiLlama backfill completion, partner fees, reconciliation, accrual, the
 * batcher, payouts and the monthly report. Those are money-path and
 * month-boundary sensitive; running them 24x more often is not "fresher data",
 * it is a different program.
 *
 * runScorer stamps public_data_refresh_state, so it is what actually makes
 * /stats and /leaderboard report dataFresh.
 */
export async function runRefreshSteps(
  staleBefore: Date,
  deadlineMs: number,
): Promise<{ completed: boolean }> {
  const { inserted } = await runFetcher(undefined, { staleBefore, deadlineMs });
  // Re-check before the remaining steps. The fetch is bounded between owners,
  // but the pricer paginates a backlog and the scorer refreshes a matview, so
  // starting them past the budget would put the whole refresh back on course to
  // cross 02:00 while holding the pipeline lock.
  if (Date.now() >= deadlineMs) {
    log.error({ inserted }, 'intraday refresh hit its budget; skipping price/score and NOT recording the boundary');
    return { completed: false };
  }
  const priced = await runPricer();
  const scored = await runScorer();
  log.info({ inserted, priced, scored }, 'intraday refresh complete');
  return { completed: true };
}

let refreshStartedAt = 0; // 0 = no refresh in flight
// Enforced COOPERATIVELY inside runFetcher (it stops between owners) and again
// before price/score -- NOT by racing a timeout, which would release the PIPELINE
// lock while FETCHER_LOCK_KEY was still held and make the nightly's own fetch
// return a silent zero before first-of-month money steps.
const REFRESH_MAX_RUNTIME_MS = 20 * 60 * 1_000;
// A refresh must never still be running when the nightly comes due.
const REFRESH_QUIET_BEFORE_NIGHTLY_MS = 60 * 60 * 1_000;

/**
 * Is `nowMs` close enough to the next 02:00 that a refresh started now could
 * still be running when the nightly comes due? Pure.
 */
export function isInsideNightlyQuietWindow(nowMs: number): boolean {
  const nextNightly = lastNightlyBoundary(nowMs).getTime() + 86_400_000;
  return nextNightly - nowMs <= REFRESH_QUIET_BEFORE_NIGHTLY_MS;
}

async function refreshTick(): Promise<void> {
  if (refreshStartedAt) {
    if (Date.now() - refreshStartedAt < REFRESH_MAX_RUNTIME_MS) return;
    log.error({ runningMs: Date.now() - refreshStartedAt }, 'intraday refresh presumed wedged; releasing the in-flight guard');
    refreshStartedAt = 0;
  }
  const now = Date.now();
  const boundary = lastRefreshBoundary(now, refreshIntervalMs());
  if (!(await isRefreshDue(boundary))) return;
  // NEVER compete with a due nightly. withPipelineLock's non-waiting path only
  // defers once the nightly holds NIGHTLY_PENDING_LOCK_KEY, so a refresh taking
  // the pipeline lock microseconds earlier still wins and the nightly burns its
  // bounded wait, skipping the batcher, accrual and reconciliation.
  if (await isNightlyDue(lastNightlyBoundary(now))) {
    log.info('intraday refresh deferred: a nightly run is due');
    return;
  }
  // And do not START one close to 02:00, so a slow run cannot overlap it.
  if (isInsideNightlyQuietWindow(now)) {
    log.info('intraday refresh deferred: inside the quiet window before the nightly');
    return;
  }
  // Re-sample the clock. `now` was taken before two awaits (isRefreshDue and
  // isNightlyDue); if the database was slow, minutes may have passed and the
  // quiet-window decision above could already be stale.
  const settled = Date.now();
  if (isInsideNightlyQuietWindow(settled) || (await isNightlyDue(lastNightlyBoundary(settled)))) {
    log.info('intraday refresh deferred: the nightly became due, or the quiet window opened, while checking');
    return;
  }
  refreshStartedAt = Date.now();
  try {
    const ran = await withPipelineLock(async () => {
      // 20-minute budget inside a 60-minute window: worst case is the budget
      // plus one owner's chain sweep (~140s), so a refresh cannot reach 02:00.
      const { completed } = await runRefreshSteps(boundary, Date.now() + REFRESH_MAX_RUNTIME_MS);
      // Do not claim a boundary the run did not finish -- it stays due and the
      // next tick retries it.
      if (completed) await recordRefreshRun(boundary);
    });
    if (!ran) log.info('intraday refresh skipped: pipeline busy');
  } catch (err: any) {
    log.error({ err: err?.message ?? err }, 'intraday refresh failed');
  } finally {
    refreshStartedAt = 0;
  }
}

export function startCron(): void {
  // Poll, do not schedule. See nightlyTick.
  setInterval(() => {
    void nightlyTick().catch((err) => log.error({ err }, 'nightly tick failed'));
  }, NIGHTLY_POLL_MS).unref?.();
  // Run one tick promptly so a deploy that lands after a missed 02:00 catches up
  // immediately instead of waiting out the first poll interval.
  void nightlyTick().catch((err) => log.error({ err }, 'nightly tick failed'));
  log.info({ pollMinutes: NIGHTLY_POLL_MS / 60_000 }, 'nightly pipeline: polling for a due run after 02:00 UTC');

  // Intraday refresh. Same poll-do-not-schedule shape and its OWN durable record.
  // NO immediate tick: startCron() runs at index.ts:16, BEFORE the one-shot
  // startup backfill, and both take the pipeline lock non-waiting. On a fresh
  // deploy refresh_runs is empty so a refresh is necessarily due and could win
  // that race; the backfill would then skip PERMANENTLY, losing its DefiLlama
  // queue drain, readiness completion and repairs until the next nightly.
  setInterval(() => {
    void refreshTick().catch((err) => log.error({ err }, 'refresh tick failed'));
  }, NIGHTLY_POLL_MS).unref?.();
  log.info({ refreshMinutes: refreshIntervalMs() / 60_000 }, 'intraday refresh: polling for a due fetch/price/score');
}
