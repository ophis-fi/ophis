import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOphisOrderDomain } from '@ophis/sdk';
import type { OphisAgentWallet } from '../src/wallet.js';

const mocks = vi.hoisted(() => ({ quote: vi.fn(), send: vi.fn(), enroll: vi.fn() }));
vi.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: class {
    getQuote = mocks.quote;
    sendOrder = mocks.send;
  },
  SigningScheme: { EIP712: 'eip712' },
  OrderQuoteSideKindSell: { SELL: 'sell' },
}));
vi.mock('@cowprotocol/app-data', () => ({
  MetadataApi: class {
    async generateAppDataDoc(input: unknown) { return input; }
  },
  stringifyDeterministic: async (input: unknown) => JSON.stringify(input),
}));
vi.mock('@ophis/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ophis/sdk')>();
  return { ...actual, enrollOphisTrader: mocks.enroll };
});

import { executeOphisSwap } from '../src/swap.js';

const SELL = '0x3600000000000000000000000000000000000000';
const BUY = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const params = { sellToken: SELL, buyToken: BUY, sellAmount: '1' };
function wallet(): OphisAgentWallet {
  return {
    getChainId: () => 5042,
    getAddress: () => '0x1111111111111111111111111111111111111111',
    readErc20Decimals: vi.fn(async () => 6),
    ensureErc20Allowance: vi.fn(async () => {}),
    signTypedData: vi.fn(async () => `0x${'ab'.repeat(65)}` as `0x${string}`),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Arc agent-swap with the current SDK', () => {
  it.each([undefined, '', 'partner_1'])('builds ERC-20 orders with rebate enrollment (code %s)', async (referralCode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.enroll.mockResolvedValue({ enrolled: true });
    // This fails when test dependencies accidentally resolve the older pre-Arc SDK.
    expect(getOphisOrderDomain(5042).verifyingContract).toBe('0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A');
    mocks.quote.mockResolvedValue({ quote: { sellToken: SELL, buyToken: BUY, sellAmount: '1000000', feeAmount: '0', buyAmount: '900000' } });
    mocks.send.mockResolvedValue('uid');
    const agentWallet = wallet();
    await expect(executeOphisSwap(agentWallet, params, { referralCode, isStablePair: true })).resolves.toMatchObject({ orderUid: 'uid', chainId: 5042 });
    const appData = JSON.parse(mocks.quote.mock.lastCall?.[0].appData);
    expect(appData.metadata.partnerFee).toMatchObject({ volumeBps: 1 });
    expect(appData.metadata.ophisReferrer?.code).toBe(referralCode || undefined);
    expect(mocks.enroll).toHaveBeenCalledWith(agentWallet.getAddress());
    expect(agentWallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({ domain: getOphisOrderDomain(5042) }));
  });

  it('reports an Arc enrollment failure without blocking settlement', async () => {
    mocks.enroll.mockRejectedValue(new Error('indexer unavailable'));
    mocks.quote.mockResolvedValue({ quote: { sellToken: SELL, buyToken: BUY, sellAmount: '1000000', feeAmount: '0', buyAmount: '900000' } });
    mocks.send.mockResolvedValue('uid');
    const agentWallet = wallet();
    await expect(executeOphisSwap(agentWallet, params, { referralCode: 'partner_1' })).resolves.toMatchObject({
      orderUid: 'uid', enrollmentWarning: expect.stringContaining('indexer unavailable'),
    });
    expect(agentWallet.signTypedData).toHaveBeenCalledOnce();
  });

  it.each([
    ['sellToken', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'],
    ['buyToken', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'],
    ['sellToken', '0x0000000000000000000000000000000000000000'],
    ['buyToken', '0x0000000000000000000000000000000000000000'],
  ])('rejects the native %s sentinel %s before token reads', async (field, token) => {
    const agentWallet = wallet();
    await expect(executeOphisSwap(agentWallet, { ...params, [field]: token }, {})).rejects.toThrow(/ERC-20|ERC20/);
    expect(agentWallet.readErc20Decimals).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(agentWallet.ensureErc20Allowance).not.toHaveBeenCalled();
    expect(agentWallet.signTypedData).not.toHaveBeenCalled();
  });
});
