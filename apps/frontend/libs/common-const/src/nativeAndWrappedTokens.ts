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

import { MONAD_CHAIN_ID, MONAD_LOGO, XLAYER_CHAIN_ID, XLAYER_LOGO } from './bridgeDestinationConst'
import { TokenWithLogo } from './types'

export const NATIVE_CURRENCY_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Ophis fork: OP mainnet (chain 10) WETH address
const OPTIMISM_WETH_ADDRESS = '0x4200000000000000000000000000000000000006'

// Ophis fork: Unichain mainnet (chain 130) WETH address.
// Unichain is an OP-Stack rollup, so WETH9 lives at the standard OP-Stack
// predeploy slot 0x4200…0006.
const UNICHAIN_WETH_ADDRESS = '0x4200000000000000000000000000000000000006'

// Ophis fork: Robinhood Chain mainnet (4663) WETH9.
const ROBINHOOD_WETH_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
const ETHEREUM_NATIVE_TOKEN_LOGO = ALL_SUPPORTED_CHAINS_MAP[SupportedChainId.MAINNET].nativeCurrency.logoUrl
const ETHEREUM_WRAPPED_TOKEN_LOGO = WRAPPED_NATIVE_CURRENCIES_SDK[SupportedChainId.MAINNET].logoUrl

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
  // Ophis fork: WETH on Unichain mainnet (chain 130)
  [130 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    130 as unknown as SupportedChainId,
    UNICHAIN_WETH_ADDRESS,
    18,
    'WETH',
    'Wrapped Ether',
  ),
  // Ophis fork: WETH on Robinhood Chain mainnet (chain 4663)
  [4663 as unknown as SupportedChainId]: new TokenWithLogo(
    ETHEREUM_WRAPPED_TOKEN_LOGO,
    4663 as unknown as SupportedChainId,
    ROBINHOOD_WETH_ADDRESS,
    18,
    'WETH',
    'Wrapped Ether',
  ),
  // Ophis fork: NEAR Intents bridge destinations. getWrappedToken() maps a
  // native output through this table (USD value, price impact, approval
  // preview), so native MON / OKB need their wrapped twins. Both verified
  // on-chain 2026-09-11 (symbol / name / decimals via eth_call).
  [MONAD_CHAIN_ID as SupportedChainId]: new TokenWithLogo(
    MONAD_LOGO,
    MONAD_CHAIN_ID as SupportedChainId,
    '0x3bd359C1119dA7da1D913d1c4d2B7C461115433a',
    18,
    'WMON',
    'Wrapped MON',
  ),
  [XLAYER_CHAIN_ID as SupportedChainId]: new TokenWithLogo(
    XLAYER_LOGO,
    XLAYER_CHAIN_ID as SupportedChainId,
    '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
    18,
    'WOKB',
    'Wrapped OKB',
  ),
}

export const NATIVE_CURRENCIES: Record<TargetChainId, TokenWithLogo> = {
  ...mapAllNetworks(getTokenWithLogoFromNativeCurrency),
  // Native ETH on Optimism (chain 10). OP IS in the SDK's
  // AdditionalTargetChainId, so `mapAllNetworks` would otherwise give it the
  // SDK's non-standard native address (0xDeAd…0000). The trading SDK's
  // eth-flow detection is keyed on NATIVE_CURRENCY_ADDRESS (0xEeee…EEeE), so
  // with the 0xDeAd address it never recognises the sell as native, never
  // substitutes WETH for the eth-flow quote, and the quote 404s
  // (NoLiquidity). Override to the canonical sentinel so
  // selling native ETH on OP quotes WETH (0x4200) via EthFlow.
  [10 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    10 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'ETH',
    'Ether',
  ),
  // Native ETH on Unichain (chain 130). OP-stack-style native gas token.
  // Same sentinel-address pattern as mainnet ETH; wraps to WETH at the
  // OP-stack predeploy slot 0x4200…0006 (see WRAPPED_NATIVE_CURRENCIES).
  [130 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    130 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'ETH',
    'Ether',
  ),
  // Native ETH on Robinhood Chain (chain 4663).
  [4663 as unknown as SupportedChainId]: new TokenWithLogo(
    ETHEREUM_NATIVE_TOKEN_LOGO,
    4663 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'ETH',
    'Ether',
  ),
  // Ophis fork: NEAR Intents bridge destinations (no trading); native MON / OKB
  // live here so getIsNativeToken() and native sorting treat the sentinel as
  // native for bridge output tokens.
  [MONAD_CHAIN_ID as TargetChainId]: new TokenWithLogo(
    MONAD_LOGO,
    MONAD_CHAIN_ID as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'MON',
    'Monad',
  ),
  [XLAYER_CHAIN_ID as TargetChainId]: new TokenWithLogo(
    XLAYER_LOGO,
    XLAYER_CHAIN_ID as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'OKB',
    'OKB',
  ),
  // Native XPL on Plasma (chain 9745). Plasma IS a SupportedChainId, so the
  // mapAllNetworks() spread above already creates this entry — but
  // getTokenWithLogoFromNativeCurrency() hardcodes logoUrl=undefined and drops
  // the SDK's native logo, leaving XPL with the single-letter fallback icon.
  // Re-add it here with the SDK's canonical Plasma logo (the same asset the SDK
  // exposes on nativeCurrency.logoUrl and the network badge already renders) so
  // native XPL shows its real logo in the token selector and swap form.
  [SupportedChainId.PLASMA]: new TokenWithLogo(
    'https://files.cow.fi/cow-sdk/chains/images/plasma-logo.svg',
    SupportedChainId.PLASMA,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'XPL',
    'Plasma',
  ),
}

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
