import {
  ADDITIONAL_TARGET_CHAINS_MAP,
  ALL_SUPPORTED_CHAINS_MAP,
  isSupportedChain,
  mapAllNetworks,
  mapSupportedNetworks,
  SupportedChainId,
  TargetChainId,
  WRAPPED_NATIVE_CURRENCIES as WRAPPED_NATIVE_CURRENCIES_SDK,
} from '@cowprotocol/cow-sdk'

import { TokenWithLogo } from './types'

export const NATIVE_CURRENCY_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Ophis fork: OP mainnet (chain 10) WETH address
const OPTIMISM_WETH_ADDRESS = '0x4200000000000000000000000000000000000006'

// Ophis fork: MegaETH mainnet (chain 4326) WETH address.
// MegaETH is an OP-Stack rollup, so the predeploy slot 0x4200…0006 is the
// expected WETH9 address. Confirmed 2026-05-15 — code exists at slot.
//
const MEGAETH_WETH_ADDRESS = '0x4200000000000000000000000000000000000006'

// Ophis fork: HyperEVM mainnet (chain 999) wrapped native (WHYPE).
// HyperEVM is NOT an OP-Stack chain — it does NOT use the 0x4200…0006
// predeploy slot. WHYPE is deployed at the all-5s vanity address, native
// token symbol is HYPE (18 decimals, ETH-equivalent semantics).
const HYPEREVM_WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555'

export const WRAPPED_NATIVE_CURRENCIES: Record<SupportedChainId, TokenWithLogo> = {
  ...mapSupportedNetworks(getTokenWithLogoFromWrappedNativeCurrency),
  // Ophis fork: WETH on OP mainnet
  [10 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    10 as unknown as SupportedChainId,
    OPTIMISM_WETH_ADDRESS,
    18,
    'WETH',
    'Wrapped Ether',
  ),
  // Ophis fork: WETH on MegaETH mainnet (chain 4326)
  [4326 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    4326 as unknown as SupportedChainId,
    MEGAETH_WETH_ADDRESS,
    18,
    'WETH',
    'Wrapped Ether',
  ),
  // Ophis fork: WHYPE on HyperEVM mainnet (chain 999). Native HYPE wraps to
  // WHYPE (analogous to ETH/WETH) but is NOT compatible with WETH9 — the
  // contract at 0x5555…5555 has a slightly different interface. Verify any
  // wrap/unwrap code paths once they are exercised.
  [999 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    999 as unknown as SupportedChainId,
    HYPEREVM_WHYPE_ADDRESS,
    18,
    'WHYPE',
    'Wrapped HYPE',
  ),
}

export const NATIVE_CURRENCIES: Record<TargetChainId, TokenWithLogo> = mapAllNetworks(
  getTokenWithLogoFromNativeCurrency,
)

export const WETH_MAINNET = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.MAINNET]
export const WXDAI = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.GNOSIS_CHAIN]
export const WETH_SEPOLIA = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.SEPOLIA]

function getTokenWithLogoFromNativeCurrency(chainId: TargetChainId): TokenWithLogo {
  const nativeCurrency = isSupportedChain(chainId)
    ? ALL_SUPPORTED_CHAINS_MAP[chainId].nativeCurrency
    : ADDITIONAL_TARGET_CHAINS_MAP[chainId].nativeCurrency

  return new TokenWithLogo(
    undefined,
    chainId,
    nativeCurrency.address,
    nativeCurrency.decimals,
    nativeCurrency.symbol,
    nativeCurrency.name,
  )
}

function getTokenWithLogoFromWrappedNativeCurrency(chainId: SupportedChainId): TokenWithLogo {
  const wrapped = WRAPPED_NATIVE_CURRENCIES_SDK[chainId]

  return new TokenWithLogo(wrapped.logoUrl, chainId, wrapped.address, wrapped.decimals, wrapped.symbol, wrapped.name)
}
