import { atom } from 'jotai'

import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { walletInfoAtom } from '@cowprotocol/wallet'
import { resolveFlexibleConfig } from '@cowprotocol/widget-lib'

import { correlatedTokensAtom } from 'entities/correlatedTokens'

import { injectedWidgetPartnerFeeAtom } from 'modules/injectedWidget'
import { derivedTradeStateAtom, tradeTypeAtom, TradeType, TradeTypeToWidgetTradeTypeMap } from 'modules/trade'
import { tradeQuotesAtom } from 'modules/tradeQuote'

import { getBridgeIntermediateTokenAddress } from 'common/utils/getBridgeIntermediateTokenAddress'

import { safeAppFeeAtom } from './safeAppFeeAtom'

import { isBoostedPair, resolveVolumeFeeForPair, VolumeFeePair } from '../pure/resolveVolumeFeeForPair'
import { VolumeFee } from '../types'

/**
 * The Volume fee for the pair currently in the swap form.
 *
 * The DECISION lives in `resolveVolumeFeeForPair` (modules/volumeFee/pure) so
 * that it can also be applied to a pair that is NOT the one on screen, which is
 * what a basket leg needs. This atom's remaining job is to gather inputs: read
 * the trade state, resolve the bridge-adjusted output address on a cross-chain
 * trade, and hand one pair plus the ambient config to the pure resolver.
 */
export const volumeFeeAtom = atom<VolumeFee | undefined>((get) => {
  const { chainId } = get(walletInfoAtom)
  const pair = get(tradeVolumeFeePairAtom)

  // No trade state yet. Fall through the resolver with a pair that matches no
  // token set, which keeps the Volume-only floor reachable exactly as before:
  // the floor depends on the chain, not on the tokens.
  const resolvedPair: VolumeFeePair = pair ?? {
    chainId,
    sellTokenAddress: '',
    buyTokenAddress: '',
  }

  return resolveVolumeFeeForPair(resolvedPair, {
    widgetPartnerFee: get(widgetPartnerFeeAtom),
    safeAppFee: get(safeAppFeeAtom),
    correlatedTokens: get(correlatedTokensAtom)[chainId],
  })
})

/**
 * The pair the swap form is currently quoting, shaped for the pure resolver, or
 * undefined before a trade state exists.
 *
 * Three details are carried over from the atoms this replaced, and each one
 * changes the fee if dropped:
 *
 *   - `chainId` is the connected WALLET's chain, which is what the stablecoin
 *     set and the Volume-only floor keyed on. `boostedChainId` is the TRADE's
 *     chain, which is what the boosted lookup keyed on, so a boost still matches
 *     the actual tokens while the wallet is mid-chain-switch. They differ only
 *     during that switch, and preserving the split keeps this refactor behaviour
 *     preserving rather than behaviour changing.
 *   - on a CROSS-CHAIN trade the buy address is replaced by the bridge
 *     intermediate token (or '' when it cannot be resolved). Only the correlated
 *     check ever used that substitution.
 *   - `isCrossChain` is passed explicitly rather than inferred. The bridge
 *     intermediate lives on the SELL chain, so it can be in this chain's
 *     stablecoin or boosted set; without the flag, bridging out of a boosted
 *     token would silently take the reduced rate, which the swap path never did.
 */
const tradeVolumeFeePairAtom = atom<VolumeFeePair | undefined>((get) => {
  const { chainId } = get(walletInfoAtom)
  const { inputCurrency, outputCurrency } = get(derivedTradeStateAtom) || {}

  if (!inputCurrency || !outputCurrency) return undefined

  const isCrossChain = inputCurrency.chainId !== outputCurrency.chainId
  const sellTokenAddress = getAddressKey(getCurrencyAddress(inputCurrency))
  let buyTokenAddress = getAddressKey(getCurrencyAddress(outputCurrency))

  if (isCrossChain) {
    const bridgeQuote = get(tradeQuotesAtom)[sellTokenAddress]?.bridgeQuote ?? null
    const bridgeOutputAddr = getBridgeIntermediateTokenAddress(bridgeQuote)
    buyTokenAddress = bridgeOutputAddr ? getAddressKey(bridgeOutputAddr) : ''
  }

  return {
    chainId,
    sellTokenAddress,
    buyTokenAddress,
    boostedChainId: inputCurrency.chainId,
    isCrossChain,
  }
})

/**
 * True when the current trade qualifies for the reduced boosted rate (the ALEPH
 * flagship), so the swap-box badge can show that a boost is active.
 *
 * Still an atom because the badge subscribes to it, but the predicate now comes
 * from the same pure function the fee itself uses, so the badge and the charged
 * rate can no longer disagree.
 */
export const isBoostedTradeAtom = atom<boolean>((get) => {
  const pair = get(tradeVolumeFeePairAtom)

  return pair ? isBoostedPair(pair) : false
})

/**
 * The host integrator's partnerFee with its FlexibleConfig resolved for the
 * current chain and trade type, or the Ophis fee under the flat-fee flag.
 * Exported so any surface resolving a fee for a NON-form pair (basket legs) can
 * feed the same ambient input into `resolveVolumeFeeForPair`.
 */
export const widgetPartnerFeeAtom = atom<VolumeFee | undefined>((get) => {
  const { chainId } = get(walletInfoAtom)
  const partnerFee = get(injectedWidgetPartnerFeeAtom)
  const tradeType = get(tradeTypeAtom)?.tradeType

  if (!tradeType || !partnerFee) {
    return undefined
  }

  const bps = resolveFlexibleConfig(partnerFee.bps, chainId, TradeTypeToWidgetTradeTypeMap[tradeType])
  const recipient = resolveFlexibleConfig(partnerFee.recipient, chainId, TradeTypeToWidgetTradeTypeMap[tradeType])

  if (!bps || !recipient) return undefined

  return {
    volumeBps: bps,
    recipient,
  }
})

/**
 * Widget Volume fee for a BASKET leg, resolved for the SWAP (market) order type
 * explicitly rather than from `tradeTypeAtom`.
 *
 * `widgetPartnerFeeAtom` reads the trade type from the URL (`tradeTypeAtom`),
 * which is null on a dedicated basket route (`useTradeTypeInfoFromUrl` knows only
 * swap/limit/advanced/yield). It would then return undefined and, under the
 * flat-volume flag, drop the fee for every basket leg in both the quote and the
 * signed appData. A basket leg is a market swap, so pin the widget trade type to
 * SWAP and stay independent of the route the basket happens to be mounted on.
 */
export const basketWidgetVolumeFeeAtom = atom<VolumeFee | undefined>((get) => {
  const { chainId } = get(walletInfoAtom)
  const partnerFee = get(injectedWidgetPartnerFeeAtom)

  if (!partnerFee) return undefined

  const widgetTradeType = TradeTypeToWidgetTradeTypeMap[TradeType.SWAP]
  const bps = resolveFlexibleConfig(partnerFee.bps, chainId, widgetTradeType)
  const recipient = resolveFlexibleConfig(partnerFee.recipient, chainId, widgetTradeType)

  if (!bps || !recipient) return undefined

  return {
    volumeBps: bps,
    recipient,
  }
})
