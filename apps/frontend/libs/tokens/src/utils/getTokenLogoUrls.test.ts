import {
  ARC_CIRBTC,
  ARC_EURC,
  ARC_USDC,
  ARC_USYC,
  TokenWithLogo,
  USDG_LOGO_URL,
  USDG_ROBINHOOD,
  WETH_MAINNET,
} from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { getTokenLogoUrls } from './getTokenLogoUrls'

import MPS_LOGO from '../assets/mps.svg'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'

describe('getTokenLogoUrls', () => {
  it.each([ARC_USDC, ARC_EURC, ARC_CIRBTC, ARC_USYC])(
    'restores the $symbol logo for saved Arc favourites without artwork',
    (token) => {
      const saved = new TokenWithLogo(
        undefined,
        token.chainId,
        token.address.toLowerCase(),
        token.decimals,
        token.symbol,
      )
      expect(getTokenLogoUrls(saved)[0]).toBe(token.logoURI)
      const wrongChain = new TokenWithLogo(
        undefined,
        SupportedChainId.BASE,
        token.address,
        token.decimals,
        token.symbol,
      )
      expect(getTokenLogoUrls(wrongChain)).not.toContain(token.logoURI)
    },
  )
  it.each([
    [SupportedChainId.MAINNET, '0x96c645d3d3706f793ef52c19bbace441900ed47d'],
    [SupportedChainId.GNOSIS_CHAIN, '0xfa57aa7beed63d03aaf85ffd1753f5f6242588fb'],
  ])('uses the bundled official MPS logo on chain %s', (chainId, address) => {
    const token = new TokenWithLogo(undefined, chainId, address, 0, 'MPS', 'Mt Pelerin Shares')
    expect(getTokenLogoUrls(token)[0]).toBe(MPS_LOGO)
  })

  it('does not assign MPS artwork to the same address on another chain', () => {
    const token = new TokenWithLogo(
      undefined,
      SupportedChainId.BASE,
      '0x96c645d3d3706f793ef52c19bbace441900ed47d',
      0,
      'MPS',
    )
    expect(getTokenLogoUrls(token)).not.toContain(MPS_LOGO)
  })

  it('uses the official bright Robinhood logo fallback for Stock Tokens', () => {
    const token = new TokenWithLogo(undefined, ROBINHOOD_CHAIN_ID, AAPL, 18, 'AAPL', 'Apple')

    expect(getTokenLogoUrls(token)[0]).toBe(
      'https://cdn.robinhood.com/ncw_assets/logos/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png',
    )
  })

  it('uses the official USDG logo for the canonical Robinhood token', () => {
    expect(USDG_ROBINHOOD.logoURI).toBe(USDG_LOGO_URL)
    expect(getTokenLogoUrls(USDG_ROBINHOOD)[0]).toBe(USDG_LOGO_URL)
    expect(getTokenLogoUrls(USDG_ROBINHOOD)[0]).toMatch(/^https:\/\//)
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
