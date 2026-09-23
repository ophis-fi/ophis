import { ARC_CHAIN_ID, ARC_EURC, ARC_USDC } from '@cowprotocol/common-const'

import { getQuoteCurrencyByStableCoin } from './index'

it('renders the Arc USDC/EURC rate in either direction', () => {
  expect(getQuoteCurrencyByStableCoin(ARC_CHAIN_ID, ARC_USDC, ARC_EURC)).toBe(ARC_EURC)
  expect(getQuoteCurrencyByStableCoin(ARC_CHAIN_ID, ARC_EURC, ARC_USDC)).toBe(ARC_USDC)
})
