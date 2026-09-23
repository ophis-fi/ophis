import { ARC_CHAIN_ID } from '@cowprotocol/common-const'

import { getExplorerAddressLink, getExplorerOrderLink } from './explorer'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  ARC_ENABLED: true,
  ARC_LOCAL: true,
  ARC_ORDERBOOK_URL: 'http://127.0.0.1:8087',
}))

it('links local Arc orders and accounts to the local orderbook', () => {
  expect(getExplorerOrderLink(ARC_CHAIN_ID, 'order-id')).toBe('http://127.0.0.1:8087/api/v1/orders/order-id')
  expect(getExplorerAddressLink(ARC_CHAIN_ID, 'owner')).toBe('http://127.0.0.1:8087/api/v1/account/owner/orders')
})
