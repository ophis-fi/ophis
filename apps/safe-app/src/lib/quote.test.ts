import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: class { getQuote = mocks.quote; },
  OrderQuoteSideKindSell: { SELL: 'sell' },
  SigningScheme: { PRESIGN: 'presign' },
}));

import { getQuote } from './quote';

const SELL = '0x3600000000000000000000000000000000000000';
const BUY = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const OWNER = '0x1111111111111111111111111111111111111111';
afterEach(() => vi.clearAllMocks());

it.each(['sell', 'buy'])('rejects an Arc native %s before requesting a quote', async (leg) => {
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  await expect(getQuote(5042, OWNER, leg === 'sell' ? native : SELL, leg === 'buy' ? native : BUY, '1000000', '{}', '0xhash'))
    .rejects.toThrow(/Arc \(5042\).*native-token/);
  expect(mocks.quote).not.toHaveBeenCalled();
});

it('quotes the original Arc ERC-20 tokens and six-decimal atomic amount', async () => {
  mocks.quote.mockResolvedValue({ quote: {} });
  await getQuote(5042, OWNER, SELL, BUY, '1000000', '{}', '0xhash');
  expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ sellToken: SELL, buyToken: BUY, sellAmountBeforeFee: '1000000' }));
});
