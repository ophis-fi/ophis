import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { getTradeRewardStatus } = await import('../../src/tradeRewards/service.js');
const WALLET = `0x${'11'.repeat(20)}` as `0x${string}`;

describe('trade reward campaign status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.campaign = { enabled: true, tickets_remaining: 105 };
    state.tickets = [];
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
