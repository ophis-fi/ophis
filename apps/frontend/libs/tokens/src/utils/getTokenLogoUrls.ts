import { cowprotocolTokenLogoUrl, TokenWithLogo, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { uriToHttp } from '@cowprotocol/common-utils'
import { areAddressesEqual, getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'

import { trustTokenLogoUrl } from './trustTokenLogoUrl'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const ROBINHOOD_USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const ROBINHOOD_WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

export function getTokenLogoUrls(token: TokenWithLogo | undefined): string[] {
  const fallbackUrls = token?.address ? getTokenLogoFallbacks(token.address, token.chainId as SupportedChainId) : []

  if (!token?.logoURI) {
    return fallbackUrls
  }

  const urls = uriToHttp(token.logoURI)

  if (fallbackUrls.length) {
    urls.push(...fallbackUrls.filter((url) => !urls.includes(url)))
  }

  return urls
}

function getTokenLogoFallbacks(address: string, chainId: SupportedChainId): string[] {
  const logos: string[] = []
  const addressKey = getAddressKey(address)

  // Robinhood's canonical Stock Token list currently omits logoURI, while its
  // first-party asset registry publishes every logo at this address-derived URL.
  // Put the bright official mark before generic list fallbacks. USDG and WETH
  // retain their familiar USDC and WETH marks even when discovered outside the
  // app's canonical token constants and arrive without logoURI.
  if (chainId === ROBINHOOD_CHAIN_ID) {
    if (areAddressesEqual(address, ROBINHOOD_USDG_ADDRESS) && USDC_MAINNET.logoURI) {
      logos.push(USDC_MAINNET.logoURI)
    } else if (areAddressesEqual(address, ROBINHOOD_WETH_ADDRESS) && WETH_MAINNET.logoURI) {
      logos.push(WETH_MAINNET.logoURI)
    } else {
      logos.push(`https://cdn.robinhood.com/ncw_assets/logos/${addressKey}.png`)
    }
  }

  logos.push(
    cowprotocolTokenLogoUrl(addressKey, chainId),
    cowprotocolTokenLogoUrl(addressKey, SupportedChainId.MAINNET),
  )

  const trustLogo = trustTokenLogoUrl(address, chainId)

  if (trustLogo) {
    logos.push(trustLogo)
  }

  return logos
}
