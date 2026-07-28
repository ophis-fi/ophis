import type { SupportedChainId } from '@cowprotocol/cow-sdk'

import { CHAIN_INFO } from './chainInfo'
import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from './nativeAndWrappedTokens'
import { ROBINHOOD_CHAIN_LOGO } from './robinhood.const'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId

describe('Robinhood official branding', () => {
  it('uses the same first-party logo for the chain, ETH, and WETH', () => {
    expect(CHAIN_INFO[ROBINHOOD_CHAIN_ID].logo).toEqual({
      light: ROBINHOOD_CHAIN_LOGO,
      dark: ROBINHOOD_CHAIN_LOGO,
    })
    expect(NATIVE_CURRENCIES[ROBINHOOD_CHAIN_ID].logoURI).toBe(ROBINHOOD_CHAIN_LOGO)
    expect(WRAPPED_NATIVE_CURRENCIES[ROBINHOOD_CHAIN_ID].logoURI).toBe(ROBINHOOD_CHAIN_LOGO)
  })
})
