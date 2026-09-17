import { USDC_GNOSIS_CHAIN, USDT as USDT_TOKEN, USDT_GNOSIS_CHAIN } from '@cowprotocol/common-const'
import { EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'

import { GNOSIS_MPS, WXDAI } from './gnosis.service'
import { GNOSIS_USDC, GNOSIS_USDT, GNOSIS_WETH, isSupportedMpsOutput, USDT } from './outputTokens.service'
import { MPS, USDC, WETH } from './router.service'

it('pins execution stablecoins to the existing token metadata', () => {
  expect([USDT, GNOSIS_USDC, GNOSIS_USDT]).toEqual([
    USDT_TOKEN.address,
    USDC_GNOSIS_CHAIN.address,
    USDT_GNOSIS_CHAIN.address,
  ])
})

it('keeps output support bound to the selected chain', () => {
  for (const token of [EVM_NATIVE_CURRENCY_ADDRESS, WETH, USDC, USDT]) expect(isSupportedMpsOutput(1, token)).toBe(true)
  for (const token of [EVM_NATIVE_CURRENCY_ADDRESS, WXDAI, GNOSIS_WETH, GNOSIS_USDC, GNOSIS_USDT])
    expect(isSupportedMpsOutput(100, token)).toBe(true)
  for (const token of [MPS, GNOSIS_MPS, GNOSIS_USDC, WXDAI]) expect(isSupportedMpsOutput(1, token)).toBe(false)
  for (const token of [MPS, GNOSIS_MPS, USDC, WETH]) expect(isSupportedMpsOutput(100, token)).toBe(false)
  expect(isSupportedMpsOutput(10, EVM_NATIVE_CURRENCY_ADDRESS)).toBe(false)
})
