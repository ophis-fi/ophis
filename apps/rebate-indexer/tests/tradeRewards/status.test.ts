import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { TRADE_REWARDS_ELIGIBLE_CHAIN_IDS } from '../../src/tradeRewards/config.js';

const state = vi.hoisted(() => ({
  campaign: { enabled: true, tickets_remaining: 105 },
  tickets: [] as Record<string, unknown>[],
}));

const sql = vi.fn(async (strings: TemplateStringsArray) => {
  const query = strings.join('');
  if (query.includes('FROM trade_reward_campaigns')) return [state.campaign];
  if (query.includes('FROM trade_reward_tickets')) return state.tickets;
  return [];
});

vi.mock('../../src/db/index.js', () => ({ sql }));

const { getTradeRewardCampaign, getTradeRewardStatus } = await import('../../src/tradeRewards/service.js');
const { registerTradeRewardRoutes } = await import('../../src/tradeRewards/routes.js');
const WALLET = `0x${'11'.repeat(20)}` as `0x${string}`;

describe('trade reward campaign status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('TRADE_REWARDS_ENABLED', 'true');
    state.campaign = { enabled: true, tickets_remaining: 105 };
    state.tickets = [];
  });

  afterEach(() => vi.unstubAllEnvs());

  it('honors the live pause switch even when the persisted campaign is enabled', async () => {
    vi.stubEnv('TRADE_REWARDS_ENABLED', 'false');
    await expect(getTradeRewardCampaign()).resolves.toMatchObject({
      campaignEnabled: false,
      campaignAvailable: false,
      ticketsRemaining: 105,
    });
  });

  it.each([
    { enabled: true, tickets_remaining: 105, available: true },
    { enabled: false, tickets_remaining: 42, available: false },
    { enabled: true, tickets_remaining: 0, available: false },
  ])('serves uncached campaign availability and canonical chains: %j', async (campaign) => {
    state.campaign = campaign;
    const app = Fastify();
    registerTradeRewardRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/trade-rewards/campaign' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      campaignEnabled: campaign.enabled,
      campaignAvailable: campaign.available,
      ticketsRemaining: campaign.tickets_remaining,
      eligibleChainIds: [...TRADE_REWARDS_ELIGIBLE_CHAIN_IDS],
    });
    await app.close();
  });

  it('reports live availability for a wallet without a ticket', async () => {
    await expect(getTradeRewardStatus(WALLET)).resolves.toEqual({
      wallet: WALLET,
      eligible: false,
      campaignEnabled: true,
      campaignAvailable: true,
      ticketsRemaining: 105,
    });
  });

  it('reports sold out while preserving an existing ticket as claimable', async () => {
    state.campaign = { enabled: true, tickets_remaining: 0 };
    state.tickets = [{
      ticket_id: 105,
      amount_usdg: '1000000',
      assignment_status: 'confirmed',
      claim_status: 'unclaimed',
      assignment_tx_hex: null,
      claim_tx_hex: null,
    }];

    await expect(getTradeRewardStatus(WALLET)).resolves.toMatchObject({
      eligible: true,
      campaignEnabled: true,
      campaignAvailable: false,
      ticketsRemaining: 0,
      ticketId: 105,
      amountUsdg: 1,
    });
  });

  it('reports a paused campaign with its remaining ticket count', async () => {
    state.campaign = { enabled: false, tickets_remaining: 42 };

    await expect(getTradeRewardStatus(WALLET)).resolves.toMatchObject({
      eligible: false,
      campaignEnabled: false,
      campaignAvailable: false,
      ticketsRemaining: 42,
    });
  });
});
