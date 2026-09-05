import { sql } from '../db/index.js';
import { getOrder } from '../cow/client.js';
import { DECODER_ETHFLOW_OWNERS } from '../fetcher.js';
import { TRADE_REWARDS_CAMPAIGN_ID } from '../tradeRewards/config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'repair-router-trades' });

/**
 * eth-flow ROUTER contracts, the same single source of truth as the stats.ts /
 * leaderboard.ts / batcher.ts exclusions. See those sites for the display and
 * payout arms of the "routers are not people" invariant; this module is the
 * DATA-REPAIR arm that removes the need for the other arms going forward.
 */
const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

export interface RouterRepairResult {
  /** trades rows found with wallet = an eth-flow router. */
  scanned: number;
  /** Rows re-attributed to the order's receiver (the real trader). */
  repaired: number;
  /** Rows left untouched (no usable receiver, order fetch failed, owner mismatch). */
  skipped: number;
  /** Router rows removed from tracked_wallets + defillama_backfill_wallets. */
  dequeued: number;
}

/**
 * Re-attribute trades that were mis-stored with wallet = an eth-flow ROUTER
 * contract to the real trader, and remove the routers from the fetch queues.
 *
 * WHY the rows exist: the owner-scoped API fetch processes tracked wallets, and
 * the canonical CoW eth-flow router (0xba3c...adec) was enrolled as one via the
 * public /tier endpoint. attributeOrder receives only the NARROW Ophis eth-flow
 * set on the API path (it cannot enumerate the shared canonical contract as an
 * owner without pulling all of CoW's eth-flow traffic), so an Ophis order whose
 * owner was the canonical router fell through the eth-flow branch and stored
 * wallet = owner = the router. The real trader is the order's `receiver`, which
 * the CoW orderbook still serves for every historical order, so the repair
 * re-fetches each mis-stored order once and rewrites the wallet.
 *
 * Receiver guard mirrors attributeOrder byte-for-byte (valid 40-hex, not the
 * owner, never another router) plus an explicit zero-address reject: a row with
 * no usable receiver is SKIPPED, never guessed. Skipped rows stay excluded from
 * every public surface and from the payout gate, so leaving them is safe.
 *
 * The queue cleanup runs even when no trade rows remain: a router sitting in
 * defillama_backfill_wallets can never drain once the fetcher stops processing
 * routers as owners (fetcher.ts drops them BEFORE the per-owner loop whose tail
 * deletes from that queue), and one stuck row holds the /defillama readiness
 * gate closed forever. Deleting the routers from both tables unsticks the gate
 * and stops the nightly re-fetch that kept re-inserting mis-stored rows.
 *
 * Idempotent: after a full repair, scanned = 0 and both deletes match nothing.
 * Per-row failures (CoW outage, pruned order) are logged and retried on the next
 * nightly run. Callers that need the change reflected in rebate ranking must
 * refresh the `wallets` matview afterwards (the nightly cron's scorer step does;
 * the CLI command runs the scorer itself).
 */
export async function repairRouterTrades(): Promise<RouterRepairResult> {
  const rows = await sql<{ trade_uid: Buffer; chain_id: number; wallet_hex: string }[]>`
    SELECT trade_uid, chain_id, encode(wallet, 'hex') AS wallet_hex
    FROM trades
    WHERE ('0x' || encode(wallet, 'hex')) = ANY(${ROUTER_WALLETS})
    ORDER BY trade_uid
  `;

  let repaired = 0;
  let skipped = 0;
  for (const r of rows) {
    const uid = `0x${r.trade_uid.toString('hex')}` as `0x${string}`;
    const storedWallet = `0x${r.wallet_hex}`;
    try {
      // A trade that already backs a reward ticket must NOT change owner. The
      // ticket's assignment_signature signs the WALLET, tickets are one-per-wallet
      // (PK) and one-per-trade (UNIQUE qualifying_trade_uid), so re-pointing the
      // trade would leave a ticket the receiver can never claim AND make the
      // re-attributed trade look candidate-eligible again: reserveTicket would
      // then hit the qualifying_trade_uid UNIQUE constraint, and since
      // candidateTrades orders deterministically, that poisoned candidate would
      // abort every scheduler run at the same spot. Leave the row router-walleted
      // (every public surface and the payout gate already exclude it) and warn:
      // an operator must decide (block the wallet / void the ticket) first.
      const ticketed = await sql`
        SELECT 1 FROM trade_reward_tickets WHERE qualifying_trade_uid = ${r.trade_uid}`;
      if (ticketed.length > 0) {
        skipped++;
        log.warn({ uid, chainId: r.chain_id }, 'router repair: trade backs a reward ticket; operator must resolve before re-attribution');
        continue;
      }
      const order = await getOrder(r.chain_id, uid);
      const owner = order.owner.toLowerCase();
      // Sanity: the mis-store recorded the order OWNER. If CoW reports a different
      // owner for this uid, the row is not the failure mode this repair targets.
      if (owner !== storedWallet) {
        skipped++;
        log.warn({ uid, chainId: r.chain_id, storedWallet, owner }, 'router repair: owner mismatch; skipping');
        continue;
      }
      const receiver = order.receiver?.trim().toLowerCase();
      if (
        !receiver ||
        !/^0x[0-9a-f]{40}$/.test(receiver) ||
        receiver === ZERO_ADDRESS ||
        receiver === owner ||
        DECODER_ETHFLOW_OWNERS.has(receiver)
      ) {
        skipped++;
        log.warn({ uid, chainId: r.chain_id, receiver: receiver ?? null }, 'router repair: no usable receiver; skipping');
        continue;
      }
      // SERIALIZED re-check + rewrite: the pre-check above is advisory (it
      // produces the clear warning); enforcement happens here, under the SAME
      // campaign advisory xact lock reserveTicket takes, in one transaction.
      // While the lock is held no reservation can commit, and reserveTicket
      // re-verifies the trade's wallet inside its own locked transaction, so the
      // check-then-update and select-then-insert pairs can never interleave into
      // a ticket signed for a wallet that no longer owns the trade. The NOT
      // EXISTS predicate stays in the UPDATE as defense in depth for any future
      // rewrite path that forgets the lock.
      const repairedThis = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${TRADE_REWARDS_CAMPAIGN_ID}))`;
        const updated = await tx`
          UPDATE trades SET wallet = decode(${receiver.slice(2)}, 'hex')
          WHERE trade_uid = ${r.trade_uid} AND chain_id = ${r.chain_id}
            AND NOT EXISTS (
              SELECT 1 FROM trade_reward_tickets WHERE qualifying_trade_uid = ${r.trade_uid}
            )
        `;
        if (updated.count > 0) {
          // Keep reporting identity synchronized with the aggregate ledger. In
          // particular, overwrite a router copied by migration 0038 rather than
          // preserving it forever through the fill upsert's null-only repair.
          await tx`
            UPDATE defillama_fills
            SET user_address = decode(${receiver.slice(2)}, 'hex')
            WHERE chain_id = ${r.chain_id} AND trade_uid = ${r.trade_uid}
          `;
        }
        return updated.count > 0;
      });
      if (!repairedThis) {
        skipped++;
        log.warn({ uid, chainId: r.chain_id }, 'router repair: ticket appeared before re-attribution; skipping');
        continue;
      }
      repaired++;
      log.info({ uid, chainId: r.chain_id, from: storedWallet, to: receiver }, 'router repair: trade re-attributed');
    } catch (err) {
      skipped++;
      log.warn({ err, uid, chainId: r.chain_id }, 'router repair: order fetch failed; will retry next run');
    }
  }

  const [dq] = await sql<{ tracked: number; backfill: number }[]>`
    WITH t AS (
      DELETE FROM tracked_wallets
      WHERE ('0x' || encode(wallet, 'hex')) = ANY(${ROUTER_WALLETS})
      RETURNING 1
    ), b AS (
      DELETE FROM defillama_backfill_wallets
      WHERE ('0x' || encode(wallet, 'hex')) = ANY(${ROUTER_WALLETS})
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM t)::int AS tracked, (SELECT COUNT(*) FROM b)::int AS backfill
  `;
  const dequeued = (dq?.tracked ?? 0) + (dq?.backfill ?? 0);

  const result = { scanned: rows.length, repaired, skipped, dequeued };
  if (rows.length > 0 || dequeued > 0) {
    log.info(result, 'router repair complete');
  }
  return result;
}
