import { ARC_CHAIN_ID } from '@cowprotocol/common-const'

import { orderBookApi } from './cowSdk'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  ARC_ENABLED: true,
  ARC_ORDERBOOK_URL: 'https://arc-mainnet.ophis.fi',
}))

it('fetches Arc bridge order details from the sovereign API', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{}',
    json: async () => ({}),
  } as Response)
  try {
    await orderBookApi.getOrder('order-id', { chainId: ARC_CHAIN_ID })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://arc-mainnet.ophis.fi/api/v1/orders/order-id')
  } finally {
    fetchSpy.mockRestore()
  }
})
