import { atom } from 'jotai'

import { STABLECOINS } from '@cowprotocol/common-const'
import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { walletInfoAtom } from '@cowprotocol/wallet'
import { resolveFlexibleConfig } from '@cowprotocol/widget-lib'

import { correlatedTokensAtom } from 'entities/correlatedTokens'

import { injectedWidgetPartnerFeeAtom } from 'modules/injectedWidget'
import { derivedTradeStateAtom, tradeTypeAtom, TradeTypeToWidgetTradeTypeMap } from 'modules/trade'
import { tradeQuotesAtom } from 'modules/tradeQuote'

import { getBridgeIntermediateTokenAddress } from 'common/utils/getBridgeIntermediateTokenAddress'

import {
  OPHIS_FLAT_VOLUME_FEE_ENABLED,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_STABLE_VOLUME_BPS,
  ophisVolumeOnlyFloorFee,
} from 'ophis/partnerFeeDefault'
import { OPHIS_BOOSTED_VOLUME_BPS, isBoostedToken } from 'ophis/boostedTokens'

import { isCorrelatedTrade } from './isCorrelatedTrade'
import { safeAppFeeAtom } from './safeAppFeeAtom'

import { VolumeFee } from '../types'

export const volumeFeeAtom = atom<VolumeFee | undefined>((get) => {
  const widgetPartnerFee = get(widgetPartnerFeeAtom)
  const safeAppFee = get(safeAppFeeAtom)
  const shouldSkipFee = get(shouldSkipFeeAtom)

  // Correlated-token trades (e.g. a like-kind wrap) are fee-exempt by design on
  // EVERY chain, matching CoW. On OP this means no Ophis fee is emitted OR
  // displayed: the order carries no partnerFee, so it stays in sync and the
  // backend floor does not apply (the floor only raises a PRESENT sub-floor fee,
  // it does not force a fee onto a fee-exempt order). This is intentional, not the
  // free-rider bypass the floor closes, so the OP floor branch below is skipped here.
  if (!widgetPartnerFee && shouldSkipFee) {
    return undefined
  }

  // When the Ophis flat-fee flag is on, the Ophis volume fee (widgetPartnerFee,
  // carrying OPHIS_DEFAULT_PARTNER_FEE) is the single source of truth for BOTH the
  // quote display and the on-chain appData fee (the direct appData fee is
  // suppressed in injectedWidgetAppDataPartnerFeeAtom). It must therefore win over
  // a Safe-App fee; otherwise enabling the flag inside a Safe App silently drops
  // the Ophis fee in favour of the Safe's recipient instead of charging flat bps. (Review P2)
  if (OPHIS_FLAT_VOLUME_FEE_ENABLED) {
    // The reduced-rate branches below rewrite the fee bps, so they must only ever
    // touch OPHIS'S OWN partner fee. If a host integrator embeds this widget with
    // their own partnerFee (a different recipient), leave it intact rather than
    // silently overriding their configured fee with an Ophis rate.
    if (
      widgetPartnerFee &&
      widgetPartnerFee.recipient.toLowerCase() === OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase()
    ) {
      // Boosted-token trades (the ALEPH flagship) pay the reduced "max rebate" rate
      // when EITHER side is a boosted token, REGARDLESS of the trader's volume tier.
      // Same single-atom source so quote display and on-chain appData stay in lockstep.
      if (get(isBoostedTradeAtom)) {
        return { ...widgetPartnerFee, volumeBps: OPHIS_BOOSTED_VOLUME_BPS }
      }
      // Stablecoin-to-stablecoin (same-chain) pairs pay the reduced flat rate (1 bp)
      // instead of the standard volume fee. Same single-atom source, so quote display
      // and on-chain appData stay in lockstep at the reduced rate.
      if (get(isStableStableTradeAtom)) {
        return { ...widgetPartnerFee, volumeBps: OPHIS_STABLE_VOLUME_BPS }
      }
    }
    return widgetPartnerFee
  }

  // Flat-fee flag OFF: on a self-hosted Volume-only chain (Optimism) the backend
  // enforces a fee FLOOR and would reject a sub-floor fee or let an ABSENT one
  // ride free, so emit the floor Volume fee HERE (the single volumeFee source) so
  // the displayed fee row and the on-chain appData fee stay in lockstep (the
  // appData price-improvement fallback is suppressed on OP). The correlated-trade
  // skip above still applies; a host integrator's own partnerFee (widgetPartnerFee)
  // takes precedence and is left intact (handled by the final return).
  if (!widgetPartnerFee) {
    const opFloorFee = get(ophisOpFloorVolumeFeeAtom)
    if (opFloorFee) return opFloorFee
  }

  // Ophis Fee won't be enabled when in Widget mode, thus it takes precedence here
  return safeAppFee || widgetPartnerFee
})

/**
 * The Ophis floor Volume fee on a self-hosted Volume-only chain (Optimism), or
 * undefined off those chains. On OP the backend floors the fee, so the Ophis fee
 * must be present at >= the floor regardless of the flat-volume flag; surfacing it
 * from this single source keeps the displayed fee and the on-chain appData fee in
 * lockstep. Reduced 1 bp rate for same-chain stable or boosted pairs.
 */
const ophisOpFloorVolumeFeeAtom = atom<VolumeFee | undefined>((get) => {
  const { chainId } = get(walletInfoAtom)
  const reducedRate = get(isStableStableTradeAtom) || get(isBoostedTradeAtom)
  return ophisVolumeOnlyFloorFee(chainId, reducedRate)
})

const shouldSkipFeeAtom = atom<boolean>((get) => {
  const { chainId } = get(walletInfoAtom)
  const { inputCurrency, outputCurrency } = get(derivedTradeStateAtom) || {}
  const correlatedTokens = get(correlatedTokensAtom)[chainId]

  if (!inputCurrency || !outputCurrency || !correlatedTokens) return false

  const inputCurrencyAddress = getAddressKey(getCurrencyAddress(inputCurrency))

  let outputCurrencyAddress = getAddressKey(getCurrencyAddress(outputCurrency))

  if (inputCurrency.chainId !== outputCurrency.chainId) {
    const tradeQuotes = get(tradeQuotesAtom)
    const bridgeQuote = tradeQuotes[inputCurrencyAddress]?.bridgeQuote ?? null

    const bridgeOutputAddr = getBridgeIntermediateTokenAddress(bridgeQuote)
    outputCurrencyAddress = bridgeOutputAddr ? getAddressKey(bridgeOutputAddr) : ''
  }

  return isCorrelatedTrade(inputCurrencyAddress, outputCurrencyAddress, correlatedTokens)
})

/**
 * True when EITHER side of a SAME-CHAIN trade is a boosted token (the ALEPH
 * flagship), so the reduced OPHIS_BOOSTED_VOLUME_BPS "max rebate" rate applies
 * regardless of the trader's volume tier. Cross-chain (bridge) trades return
 * false and keep the standard rate (a bridged leg's fee placement is ambiguous).
 * Exported so the swap-box badge can show when a boost is active.
 */
export const isBoostedTradeAtom = atom<boolean>((get) => {
  const { inputCurrency, outputCurrency } = get(derivedTradeStateAtom) || {}

  if (!inputCurrency || !outputCurrency) return false
  if (inputCurrency.chainId !== outputCurrency.chainId) return false
  // Key the lookup on the TRADE's chain (not the connected wallet's): the boost must
  // match the actual tokens even if the wallet is momentarily on a different chain.
  const chainId = inputCurrency.chainId

  return (
    isBoostedToken(chainId, getCurrencyAddress(inputCurrency)) ||
    isBoostedToken(chainId, getCurrencyAddress(outputCurrency))
  )
})

/**
 * True when BOTH sides of a SAME-CHAIN trade are stablecoins, so the reduced
 * OPHIS_STABLE_VOLUME_BPS (1 bp) applies. Cross-chain (bridge) trades return
 * false and keep the standard rate: a bridged output lives on another chain and
 * is not covered by this chain's stablecoin set, and erring toward the standard
 * fee avoids ever under-charging a non-stable bridge leg.
 */
const isStableStableTradeAtom = atom<boolean>((get) => {
  const { chainId } = get(walletInfoAtom)
  const { inputCurrency, outputCurrency } = get(derivedTradeStateAtom) || {}
  const stablecoins = STABLECOINS[chainId]

  if (!inputCurrency || !outputCurrency || !stablecoins) return false
  if (inputCurrency.chainId !== outputCurrency.chainId) return false

  const isInputStable = stablecoins.has(getAddressKey(getCurrencyAddress(inputCurrency)))
  const isOutputStable = stablecoins.has(getAddressKey(getCurrencyAddress(outputCurrency)))

  return isInputStable && isOutputStable
})

const widgetPartnerFeeAtom = atom<VolumeFee | undefined>((get) => {
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
