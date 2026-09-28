import { afterEach, expect, it, vi } from 'vitest';
import { computeOrderUid, type VaultOrder } from '../src/order.js';

const mocks = vi.hoisted(() => ({ quote: vi.fn(), send: vi.fn(), enroll: vi.fn() }));
vi.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: class { getQuote = mocks.quote; sendOrder = mocks.send; },
}));
vi.mock('@cowprotocol/app-data', () => ({
  MetadataApi: class { async generateAppDataDoc(input: unknown) { return input; } },
  stringifyDeterministic: async (input: unknown) => JSON.stringify(input),
}));
vi.mock('@ophis/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ophis/sdk')>();
  return { ...actual, enrollOphisTrader: mocks.enroll };
});

import { buildOphisSafePresign } from '../src/build.js';

const SAFE = '0x1111111111111111111111111111111111111111';
const SELL = '0x3600000000000000000000000000000000000000';
const BUY = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
afterEach(() => vi.clearAllMocks());

it.each([5042, 10])('retains fee-bearing Safe orders on %s and enrolls only indexed chains', async (chainId) => {
  mocks.quote.mockResolvedValue({ quote: { sellToken: SELL, buyToken: BUY, sellAmount: '1000000', feeAmount: '0', buyAmount: '900000' } });
  mocks.enroll.mockResolvedValue({ enrolled: true });
  mocks.send.mockImplementation(async (body: VaultOrder & { appDataHash: string }) => computeOrderUid({ ...body, appData: body.appDataHash }, chainId, SAFE));
  const result = await buildOphisSafePresign({ chainId, safe: SAFE, sellToken: SELL, buyToken: BUY, sellAmount: '1000000' });
  expect(result.enrollmentWarning).toBeUndefined();
  expect(mocks.enroll).toHaveBeenCalledTimes(chainId === 5042 ? 0 : 1);
  expect(mocks.send).toHaveBeenCalledOnce();
  const body = mocks.send.mock.calls[0]?.[0];
  expect(body).toMatchObject({ sellToken: SELL, buyToken: BUY, sellAmount: '1000000', feeAmount: '0' });
  expect(JSON.parse(body.appData).metadata.partnerFee).toMatchObject({ volumeBps: 1 });
  expect(body).not.toHaveProperty('chainId');
});
