import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { isNonEvmRecipientChain, isRecipientAddress } from 'common/utils/recipientAddress.utils'

import type { TradeFlowContext } from '../types/TradeFlowContext'

export function isBridgeQuoteRecipientCurrent(context: TradeFlowContext): boolean {
  const { buyToken, sellToken, recipient, recipientAddressOrName } = context.orderParams
  const quote = context.tradeQuoteState.bridgeQuote
  const isNonEvm = isNonEvmRecipientChain(buyToken.chainId)

  // Receiver-account quotes bind their deposit address to the original destination;
  // the SDK does not refetch them or honor a new receiver passed when posting.
  if (!isNonEvm && quote?.providerInfo.type !== 'ReceiverAccountBridgeProvider') return true
  if (!quote) return false

  const quoted = quote.tradeParameters
  const requestedRecipient = isNonEvm ? recipientAddressOrName : recipient

  return [
    quoted.sellTokenChainId === sellToken.chainId,
    quoted.buyTokenChainId === buyToken.chainId,
    // The bridge sells an intermediate asset; the CoW quote retains the original input.
    areAddressesEqual(context.tradeQuote.quoteResults.tradeParameters.sellToken, getCurrencyAddress(sellToken)),
    areAddressesEqual(quoted.buyTokenAddress, getCurrencyAddress(buyToken)),
    isRecipientAddress(requestedRecipient, buyToken.chainId),
    areAddressesEqual(requestedRecipient, recipient),
    areAddressesEqual(requestedRecipient, quoted.bridgeRecipient || quoted.receiver),
  ].every(Boolean)
}
