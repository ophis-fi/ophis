import { TokenWithLogo, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { getTokenLogoUrls } from './getTokenLogoUrls'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'

describe('getTokenLogoUrls', () => {
  it('uses the official bright Robinhood logo fallback for Stock Tokens', () => {
    const token = new TokenWithLogo(undefined, ROBINHOOD_CHAIN_ID, AAPL, 18, 'AAPL', 'Apple')

    expect(getTokenLogoUrls(token)[0]).toBe(
      'https://cdn.robinhood.com/ncw_assets/logos/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png',
    )
  })

  it('uses the USDC logo for Robinhood USDG even without token-list metadata', () => {
    const token = new TokenWithLogo(
      undefined,
      ROBINHOOD_CHAIN_ID,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      6,
      'USDG',
      'Global Dollar',
    )

    expect(getTokenLogoUrls(token)[0]).toBe(USDC_MAINNET.logoURI)
    expect(getTokenLogoUrls(token)[0]).toMatch(/^https:\/\//)
  })

  it('uses the familiar WETH logo for Robinhood WETH even without token-list metadata', () => {
    const token = new TokenWithLogo(
      undefined,
      ROBINHOOD_CHAIN_ID,
      '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      18,
      'WETH',
      'Wrapped Ether',
    )

    expect(getTokenLogoUrls(token)[0]).toBe(WETH_MAINNET.logoURI)
    expect(getTokenLogoUrls(token)[0]).toMatch(/^https:\/\//)
  })
})
