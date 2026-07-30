import { ALL_SUPPORTED_CHAINS_MAP, SupportedChainId } from '@cowprotocol/cow-sdk'

import { CHAIN_INFO } from './chainInfo'
import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from './nativeAndWrappedTokens'
import {
  ROBINHOOD_CHAIN_BRIDGE,
  ROBINHOOD_CHAIN_DOCS,
  ROBINHOOD_CHAIN_EXPLORER,
  ROBINHOOD_CHAIN_LOGO,
} from './robinhood.const'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId

describe('Robinhood official branding', () => {
  it('uses the first-party feather for the chain and Ethereum artwork for ETH assets', () => {
    expect(CHAIN_INFO[ROBINHOOD_CHAIN_ID].logo).toEqual({
      light: ROBINHOOD_CHAIN_LOGO,
      dark: ROBINHOOD_CHAIN_LOGO,
    })
    expect(NATIVE_CURRENCIES[ROBINHOOD_CHAIN_ID].logoURI).toBe(
      ALL_SUPPORTED_CHAINS_MAP[SupportedChainId.MAINNET].nativeCurrency.logoUrl,
    )
    expect(WRAPPED_NATIVE_CURRENCIES[ROBINHOOD_CHAIN_ID].logoURI).toBe(
      WRAPPED_NATIVE_CURRENCIES[SupportedChainId.MAINNET].logoURI,
    )
  })

  it('uses the current first-party docs, bridge guidance, and explorer', () => {
    expect(CHAIN_INFO[ROBINHOOD_CHAIN_ID]).toMatchObject({
      docs: ROBINHOOD_CHAIN_DOCS,
      bridge: ROBINHOOD_CHAIN_BRIDGE,
      explorer: ROBINHOOD_CHAIN_EXPLORER,
      infoLink: ROBINHOOD_CHAIN_DOCS,
    })
  })
})
