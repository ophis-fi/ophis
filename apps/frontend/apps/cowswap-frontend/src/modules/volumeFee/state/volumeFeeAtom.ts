import { atom } from 'jotai'

import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { walletInfoAtom } from '@cowprotocol/wallet'
import { resolveFlexibleConfig } from '@cowprotocol/widget-lib'

import { correlatedTokensAtom } from 'entities/correlatedTokens'

import { injectedWidgetPartnerFeeAtom } from 'modules/injectedWidget'
import { derivedTradeStateAtom, tradeTypeAtom, TradeTypeToWidgetTradeTypeMap } from 'modules/trade'
import { tradeQuotesAtom } from 'modules/tradeQuote'

import { getBridgeIntermediateTokenAddress } from 'common/utils/getBridgeIntermediateTokenAddress'

import { OPHIS_FLAT_VOLUME_FEE_ENABLED } from 'ophis/partnerFeeDefault'

import { isCorrelatedTrade } from './isCorrelatedTrade'
import { safeAppFeeAtom } from './safeAppFeeAtom'

import { VolumeFee } from '../types'

export const volumeFeeAtom = atom<VolumeFee | undefined>((get) => {
  const widgetPartnerFee = get(widgetPartnerFeeAtom)
  const safeAppFee = get(safeAppFeeAtom)
  const shouldSkipFee = get(shouldSkipFeeAtom)

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
    return widgetPartnerFee
  }

  // Ophis Fee won't be enabled when in Widget mode, thus it takes precedence here
  return safeAppFee || widgetPartnerFee
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
