import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

const chain = vi.hoisted(() => ({ claimed: false, relay: vi.fn() }));
vi.mock('../../src/tradeRewards/contract.js', async (original) => ({
  ...await original<typeof import('../../src/tradeRewards/contract.js')>(),
  rewardState: async () => ({ amount: 1_000_000n, claimed: chain.claimed }),
  relayClaim: chain.relay,
}));

const WALLET = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'aa'.repeat(32)}` as const;
let pg: StartedPostgreSqlContainer;
let sql: typeof import('../../src/db/index.js').sql;
let sponsor: typeof import('../../src/tradeRewards/service.js').sponsorTradeRewardClaim;

beforeAll(async () => {
  const started = await startPg();
  pg = started.container;
  process.env.DATABASE_URL = started.connectionUri;
  await runMigrations();
  ({ sql } = await import('../../src/db/index.js'));
  ({ sponsorTradeRewardClaim: sponsor } = await import('../../src/tradeRewards/service.js'));
}, 120_000);

afterAll(async () => { await stopPg(pg); });

beforeEach(async () => {
  chain.claimed = false;
  chain.relay.mockReset().mockImplementation(async () => { chain.claimed = true; return HASH; });
  await sql`TRUNCATE trade_reward_tickets`;
  await sql`
    INSERT INTO trade_reward_tickets (
      wallet, ticket_id, amount_usdg, qualifying_trade_uid, qualifying_chain_id,
      qualifying_value_usd, assignment_signature, signer_epoch, assignment_status
    ) VALUES (
      ${Buffer.from(WALLET.slice(2), 'hex')}, 1, 1000000, ${Buffer.alloc(56, 1)}, 4663,
      100, ${Buffer.alloc(65, 1)}, 1, 'confirmed'
    )
  `;
});

it('recovers a pre-broadcast reservation left submitted by an earlier process', async () => {
  await sql`UPDATE trade_reward_tickets SET claim_status = 'submitted'`;
  await expect(sponsor(WALLET)).resolves.toBe(HASH);
  expect(chain.relay).toHaveBeenCalledOnce();
  expect(await sql`SELECT claim_status FROM trade_reward_tickets`).toEqual([{ claim_status: 'claimed' }]);
});

it('excludes a concurrent sponsor while the same wallet is being relayed', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  chain.relay.mockImplementationOnce(async () => {
    entered();
    await pending;
    chain.claimed = true;
    return HASH;
  });
  const first = sponsor(WALLET);
  await started;
  try {
    await expect(sponsor(WALLET)).rejects.toThrow(/unavailable|already submitted/);
    expect(chain.relay).toHaveBeenCalledOnce();
  } finally {
    release();
    await first;
  }
});

it('rechecks the chain after a mined claim whose receipt was lost', async () => {
  chain.relay.mockImplementationOnce(async () => {
    chain.claimed = true;
    throw new Error('receipt connection lost');
  });
  await expect(sponsor(WALLET)).rejects.toThrow('receipt connection lost');
  await expect(sponsor(WALLET)).resolves.toBeUndefined();
  expect(chain.relay).toHaveBeenCalledOnce();
  expect(await sql`SELECT claim_status FROM trade_reward_tickets`).toEqual([{ claim_status: 'claimed' }]);
});

it('rolls back the in-progress reservation when relay fails before broadcast', async () => {
  chain.relay.mockRejectedValueOnce(new Error('RPC unavailable'));
  await expect(sponsor(WALLET)).rejects.toThrow('RPC unavailable');
  expect(await sql`SELECT claim_status FROM trade_reward_tickets`).toEqual([{ claim_status: 'unclaimed' }]);
  await expect(sponsor(WALLET)).resolves.toBe(HASH);
});
