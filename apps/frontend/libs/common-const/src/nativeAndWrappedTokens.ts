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

// 2026-05-17: the SDK's AdditionalTargetChainId enum only contains OPTIMISM=10.
// `mapAllNetworks` iterates only over chains the SDK knows — so without the
// explicit overrides below, NATIVE_CURRENCIES[999] (HYPE) and [4326]
// (MegaETH ETH) would be undefined. Result: native HYPE / native MegaETH
// ETH never appear in the swap-form's token selector for those chains; users
// can only see the wrapped forms (WHYPE, WETH). Mirror the manual approach
// already used for WRAPPED_NATIVE_CURRENCIES above.
export const NATIVE_CURRENCIES: Record<TargetChainId, TokenWithLogo> = {
  ...mapAllNetworks(getTokenWithLogoFromNativeCurrency),
  // Native HYPE on HyperEVM mainnet (chain 999). The on-chain gas token;
  // accessed via the EVM native-currency sentinel address. 18 decimals,
  // ETH-equivalent transfer semantics. Wraps to WHYPE at 0x5555…5555
  // (see WRAPPED_NATIVE_CURRENCIES above).
  [999 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    999 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'HYPE',
    'Hyperliquid',
  ),
  // Native ETH on MegaETH mainnet (chain 4326). OP-stack-style native gas
  // token. Same sentinel-address pattern as mainnet ETH; wraps to WETH at
  // the OP-stack predeploy slot 0x4200…0006 (see WRAPPED_NATIVE_CURRENCIES).
  [4326 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    4326 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'ETH',
    'Ether',
  ),
  // Native ETH on Optimism (chain 10). OP IS in the SDK's
  // AdditionalTargetChainId, so `mapAllNetworks` would otherwise give it the
  // SDK's non-standard native address (0xDeAd…0000). The trading SDK's
  // eth-flow detection is keyed on NATIVE_CURRENCY_ADDRESS (0xEeee…EEeE), so
  // with the 0xDeAd address it never recognises the sell as native, never
  // substitutes WETH for the eth-flow quote, and the quote 404s
  // (NoLiquidity). Override to the canonical sentinel like 999/4326 so
  // selling native ETH on OP quotes WETH (0x4200) via EthFlow.
  [10 as unknown as SupportedChainId]: new TokenWithLogo(
    undefined,
    10 as unknown as SupportedChainId,
    NATIVE_CURRENCY_ADDRESS,
    18,
    'ETH',
    'Ether',
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
