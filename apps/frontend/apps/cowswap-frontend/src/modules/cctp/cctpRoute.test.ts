import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'

import { cctpToken } from './cctpAssets.const'
import { cctpInitialSelection } from './cctpRoute.utils'

it('hands Arc tokens to their supported bridge route and keeps unsupported tokens explicit', () => {
  expect(cctpInitialSelection('', 5042)).toEqual({ asset: 'USDC', source: 5042, destination: 8453 })
  expect(cctpInitialSelection(`?source=5042&token=${cctpToken(5042, 'WETH')}`, 10)).toEqual({
    asset: 'WETH',
    source: 5042,
    destination: 1,
  })
  expect(cctpInitialSelection('?asset=EURC&source=8453', 10)).toEqual({
    asset: 'EURC',
    source: 8453,
    destination: 5042,
  })
  expect(cctpInitialSelection('?source=invalid&asset=constructor&token=javascript:alert(1)', 10)).toEqual({
    asset: 'USDC',
    source: 8453,
    destination: 5042,
  })
  const token = '0x178b01f61cbea1d2a5581fe1621be607835ec349'
  expect(cctpInitialSelection(`?source=5042&token=${token}`, 10)).toEqual({
    asset: 'USDC',
    source: 5042,
    destination: 8453,
    swapFirstToken: token,
  })
  expect(cctpInitialSelection('?source=1&token=WETH', 5042)).toEqual({ asset: 'WETH', source: 1, destination: 5042 })
  expect(cctpInitialSelection('?source=1&token=ETH', 5042)).toEqual({
    asset: 'USDC',
    source: 1,
    destination: 5042,
    swapFirstToken: NATIVE_CURRENCY_ADDRESS,
  })
  expect(cctpInitialSelection('?source=5042&token=USDC', 1)).toEqual({ asset: 'USDC', source: 5042, destination: 8453 })
  expect(cctpInitialSelection(`?source=5042&token=${NATIVE_CURRENCY_ADDRESS}`, 1)).toEqual({
    asset: 'USDC',
    source: 5042,
    destination: 8453,
  })
  expect(cctpInitialSelection(`?source=4663&token=${token}`, 4663)).toEqual({
    asset: 'USDC',
    source: 8453,
    destination: 5042,
  })
  expect(
    cctpInitialSelection(`?source=5042&token=${cctpToken(5042, 'WETH').toUpperCase().replace('0X', '0x')}`, 10).asset,
  ).toBe('WETH')
})
