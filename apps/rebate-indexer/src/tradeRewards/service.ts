import type { Hex } from 'viem';
import { open } from 'node:fs/promises';
import { sql } from '../db/index.js';
import { logger } from '../logger.js';
import { allocationCommitment, buildRewardAllocation, parseAllocationSeed } from './allocation.js';
import {
  TRADE_REWARDS_CAMPAIGN_ID,
  TRADE_REWARDS_ELIGIBLE_CHAIN_IDS,
  TRADE_REWARDS_MAX_TICKETS,
  TRADE_REWARDS_MINIMUM_SWAP_USD,
} from './config.js';
import { assertRewardsContractReady, relayAssignment, relayClaim, rewardState, signRewardAssignment } from './contract.js';

const log = logger.child({ module: 'trade-rewards' });

interface CandidateTrade {
  readonly trade_uid_hex: string;
  readonly wallet_hex: string;
  readonly chain_id: number;
  readonly value_usd: string;
}

export interface TradeRewardStatus {
  readonly wallet: `0x${string}`;
  readonly eligible: boolean;
  readonly campaignEnabled: boolean;
  readonly campaignAvailable: boolean;
  readonly ticketsRemaining: number;
  readonly ticketId?: number;
  readonly amountUsdg?: number;
  readonly assignmentStatus?: string;
  readonly claimStatus?: string;
  readonly assignmentTxHash?: `0x${string}`;
  readonly claimTxHash?: `0x${string}`;
}

function enabledFromEnv(): boolean {
  const raw = process.env.TRADE_REWARDS_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`TRADE_REWARDS_ENABLED must be true, 1, false, 0, or unset; got "${raw}"`);
}

async function campaignAllocation(): Promise<readonly bigint[]> {
  const seedPath = process.env.TRADE_REWARDS_ALLOCATION_SEED_FILE?.trim();
  if (!seedPath) throw new Error('TRADE_REWARDS_ALLOCATION_SEED_FILE is required');
  const handle = await open(seedPath, 'r');
  let rawSeed: string;
  try {
    const seedMetadata = await handle.stat();
    if (!seedMetadata.isFile() || (seedMetadata.mode & 0o077) !== 0) {
      throw new Error('TRADE_REWARDS_ALLOCATION_SEED_FILE must be a regular file with mode 0600 or stricter');
    }
    rawSeed = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const seed = parseAllocationSeed(rawSeed.trim());
  const allocation = buildRewardAllocation(seed);
  const commitment = allocationCommitment(seed, allocation);
  const commitmentBytes = Buffer.from(commitment.slice(2), 'hex');
  const enabled = enabledFromEnv();
  const rows = await sql<{ commitment_hex: string; enabled: boolean }[]>`
    INSERT INTO trade_reward_campaigns (campaign_id, allocation_commitment, enabled)
    VALUES (${TRADE_REWARDS_CAMPAIGN_ID}, ${commitmentBytes}, ${enabled})
    ON CONFLICT (campaign_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING encode(allocation_commitment, 'hex') AS commitment_hex, enabled
  `;
  if (`0x${rows[0]?.commitment_hex}` !== commitment) {
    throw new Error('trade reward allocation seed does not match the immutable stored commitment');
  }
  if (!rows[0]?.enabled) throw new Error('trade reward campaign is disabled');
  return allocation;
}

async function candidateTrades(limit = 25): Promise<CandidateTrade[]> {
  return sql<CandidateTrade[]>`
    SELECT
      encode(t.trade_uid, 'hex') AS trade_uid_hex,
      encode(t.wallet, 'hex') AS wallet_hex,
      t.chain_id,
      t.value_usd::text
    FROM trades t
    JOIN trade_reward_campaigns c ON c.campaign_id = ${TRADE_REWARDS_CAMPAIGN_ID}
    LEFT JOIN trade_reward_tickets rt ON rt.wallet = t.wallet
    LEFT JOIN trade_reward_wallet_blocks rb ON rb.wallet = t.wallet
    WHERE rt.wallet IS NULL
      AND rb.wallet IS NULL
      AND t.chain_id = ANY(${[...TRADE_REWARDS_ELIGIBLE_CHAIN_IDS]})
      AND t.value_usd >= ${TRADE_REWARDS_MINIMUM_SWAP_USD}
      AND t.fee_verified = true
      AND t.volume_fee_bps > 0
      AND t.sell_token <> t.buy_token
      AND t.block_timestamp >= c.created_at
    ORDER BY t.block_timestamp ASC, t.trade_uid ASC
    LIMIT ${limit}
  `;
}

async function reserveTicket(candidate: CandidateTrade, allocation: readonly bigint[]): Promise<boolean> {
  const wallet = `0x${candidate.wallet_hex}` as `0x${string}`;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TRADE_REWARDS_CAMPAIGN_ID}))`;
    const campaignRows = await tx<{ next_allocation_index: number; enabled: boolean }[]>`
      SELECT next_allocation_index, enabled
      FROM trade_reward_campaigns
      WHERE campaign_id = ${TRADE_REWARDS_CAMPAIGN_ID}
      FOR UPDATE
    `;
    const campaign = campaignRows[0];
    if (!campaign?.enabled || campaign.next_allocation_index >= TRADE_REWARDS_MAX_TICKETS) return false;
    const blocked = await tx`SELECT 1 FROM trade_reward_wallet_blocks WHERE wallet = ${Buffer.from(candidate.wallet_hex, 'hex')}`;
    if (blocked.length > 0) return false;
    const existing = await tx`SELECT 1 FROM trade_reward_tickets WHERE wallet = ${Buffer.from(candidate.wallet_hex, 'hex')}`;
    if (existing.length > 0) return false;

    const ticketId = campaign.next_allocation_index + 1;
    const amount = allocation[campaign.next_allocation_index];
    if (amount === undefined) throw new Error('allocation index out of bounds');
    const { signature, signerEpoch } = await signRewardAssignment(wallet, BigInt(ticketId), amount);
    await tx`
      INSERT INTO trade_reward_tickets (
        wallet, ticket_id, amount_usdg, qualifying_trade_uid,
        qualifying_chain_id, qualifying_value_usd, assignment_signature, signer_epoch
      ) VALUES (
        ${Buffer.from(candidate.wallet_hex, 'hex')}, ${ticketId}, ${amount.toString()},
        ${Buffer.from(candidate.trade_uid_hex, 'hex')}, ${candidate.chain_id}, ${candidate.value_usd},
        ${Buffer.from(signature.slice(2), 'hex')}, ${signerEpoch.toString()}
      )
    `;
    await tx`
      UPDATE trade_reward_campaigns
      SET next_allocation_index = ${ticketId}, updated_at = now()
      WHERE campaign_id = ${TRADE_REWARDS_CAMPAIGN_ID}
    `;
    return true;
  });
}

async function submitPendingAssignments(): Promise<number> {
  const rows = await sql<{
    wallet_hex: string; ticket_id: number; amount_usdg: string;
  }[]>`
    SELECT encode(wallet, 'hex') AS wallet_hex, ticket_id, amount_usdg::text
    FROM trade_reward_tickets
    WHERE assignment_status IN ('pending', 'submitted', 'failed')
    ORDER BY ticket_id
    LIMIT 10
  `;
  let submitted = 0;
  for (const row of rows) {
    const wallet = `0x${row.wallet_hex}` as `0x${string}`;
    try {
      const onchain = await rewardState(wallet);
      if (onchain.amount === BigInt(row.amount_usdg)) {
        await sql`
          UPDATE trade_reward_tickets SET assignment_status = 'confirmed', updated_at = now()
          WHERE wallet = ${Buffer.from(row.wallet_hex, 'hex')}
        `;
        submitted += 1;
        continue;
      }
      const { signature, signerEpoch } = await signRewardAssignment(
        wallet, BigInt(row.ticket_id), BigInt(row.amount_usdg),
      );
      await sql`
        UPDATE trade_reward_tickets
        SET assignment_signature = ${Buffer.from(signature.slice(2), 'hex')},
            signer_epoch = ${signerEpoch.toString()}, updated_at = now()
        WHERE wallet = ${Buffer.from(row.wallet_hex, 'hex')}
      `;
      const hash = await relayAssignment(
        wallet,
        BigInt(row.ticket_id),
        BigInt(row.amount_usdg),
        signature,
      );
      await sql`
        UPDATE trade_reward_tickets
        SET assignment_status = 'confirmed', assignment_tx_hash = ${Buffer.from(hash.slice(2), 'hex')}, updated_at = now()
        WHERE wallet = ${Buffer.from(row.wallet_hex, 'hex')}
      `;
      submitted += 1;
    } catch (err) {
      await sql`
        UPDATE trade_reward_tickets SET assignment_status = 'failed', updated_at = now()
        WHERE wallet = ${Buffer.from(row.wallet_hex, 'hex')}
      `;
      log.error({ err, wallet, ticketId: row.ticket_id }, 'reward assignment relay failed');
    }
  }
  return submitted;
}

export async function runTradeRewards(): Promise<{ reserved: number; submitted: number }> {
  if (!enabledFromEnv()) return { reserved: 0, submitted: 0 };
  await assertRewardsContractReady();
  const allocation = await campaignAllocation();
  let reserved = 0;
  for (const candidate of await candidateTrades()) {
    if (await reserveTicket(candidate, allocation)) reserved += 1;
  }
  const submitted = await submitPendingAssignments();
  return { reserved, submitted };
}

export async function getTradeRewardStatus(wallet: `0x${string}`): Promise<TradeRewardStatus> {
  const campaignRows = await sql<{ enabled: boolean; tickets_remaining: number }[]>`
    SELECT enabled,
           GREATEST(${TRADE_REWARDS_MAX_TICKETS} - next_allocation_index, 0)::integer AS tickets_remaining
    FROM trade_reward_campaigns
    WHERE campaign_id = ${TRADE_REWARDS_CAMPAIGN_ID}
  `;
  const campaign = campaignRows[0];
  const campaignEnabled = campaign?.enabled === true;
  const ticketsRemaining = campaign?.tickets_remaining ?? 0;
  const campaignAvailable = campaignEnabled && ticketsRemaining > 0;
  const rows = await sql<{
    ticket_id: number; amount_usdg: string; assignment_status: string; claim_status: string;
    assignment_tx_hex: string | null; claim_tx_hex: string | null;
  }[]>`
    SELECT ticket_id, amount_usdg::text, assignment_status, claim_status,
           encode(assignment_tx_hash, 'hex') AS assignment_tx_hex,
           encode(claim_tx_hash, 'hex') AS claim_tx_hex
    FROM trade_reward_tickets
    WHERE wallet = ${Buffer.from(wallet.slice(2), 'hex')}
  `;
  const row = rows[0];
  if (!row) return { wallet, eligible: false, campaignEnabled, campaignAvailable, ticketsRemaining };
  return {
    wallet,
    eligible: true,
    campaignEnabled,
    campaignAvailable,
    ticketsRemaining,
    ticketId: row.ticket_id,
    amountUsdg: Number(BigInt(row.amount_usdg)) / 1_000_000,
    assignmentStatus: row.assignment_status,
    claimStatus: row.claim_status,
    assignmentTxHash: row.assignment_tx_hex ? `0x${row.assignment_tx_hex}` : undefined,
    claimTxHash: row.claim_tx_hex ? `0x${row.claim_tx_hex}` : undefined,
  };
}

export async function sponsorTradeRewardClaim(wallet: `0x${string}`): Promise<Hex | undefined> {
  const walletBytes = Buffer.from(wallet.slice(2), 'hex');
  const existing = await rewardState(wallet);
  if (existing.claimed) {
    const rows = await sql<{ claim_tx_hex: string | null }[]>`
      UPDATE trade_reward_tickets SET claim_status = 'claimed', updated_at = now()
      WHERE wallet = ${walletBytes}
      RETURNING encode(claim_tx_hash, 'hex') AS claim_tx_hex
    `;
    if (rows.length === 0) throw new Error('reward is not registered for this wallet');
    return rows[0]?.claim_tx_hex ? `0x${rows[0].claim_tx_hex}` as Hex : undefined;
  }
  const locked = await sql`
    UPDATE trade_reward_tickets
    SET claim_status = 'submitted', updated_at = now()
    WHERE wallet = ${walletBytes}
      AND assignment_status = 'confirmed'
      AND claim_status IN ('unclaimed', 'failed')
    RETURNING 1
  `;
  if (locked.length === 0) throw new Error('reward is unavailable, unassigned, or already submitted');
  try {
    const hash = await relayClaim(wallet);
    await sql`
      UPDATE trade_reward_tickets
      SET claim_status = 'claimed', claim_tx_hash = ${Buffer.from(hash.slice(2), 'hex')}, updated_at = now()
      WHERE wallet = ${walletBytes}
    `;
    return hash;
  } catch (err) {
    await sql`
      UPDATE trade_reward_tickets SET claim_status = 'failed', updated_at = now()
      WHERE wallet = ${walletBytes}
    `;
    throw err;
  }
}
