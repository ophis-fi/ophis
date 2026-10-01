import { isSellOrder } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'

import { TRADE_URL_BUY_AMOUNT_KEY, TRADE_URL_ORDER_KIND_KEY, TRADE_URL_SELL_AMOUNT_KEY } from '../const/tradeUrl'

export type TradeSearchParams = {
  amount?: string
  kind?: OrderKind
  targetChainId?: number
  clearRecipient?: boolean
}

/**
 * Add/replace searchParams to existing search string
 * @param search Existing search params string
 * @param searchParamsToAdd Stuff to add
 */
export function parameterizeTradeSearch(search: string, searchParamsToAdd?: TradeSearchParams): string {
  const searchParams = new URLSearchParams(search)
  const { amount, kind, targetChainId, clearRecipient } = searchParamsToAdd ?? {}

  const amountQueryKey = kind ? (isSellOrder(kind) ? TRADE_URL_SELL_AMOUNT_KEY : TRADE_URL_BUY_AMOUNT_KEY) : undefined

  if (amount === '') {
    searchParams.delete(TRADE_URL_SELL_AMOUNT_KEY)
    searchParams.delete(TRADE_URL_BUY_AMOUNT_KEY)
    searchParams.delete(TRADE_URL_ORDER_KIND_KEY)
  } else if (amount && amountQueryKey) {
    searchParams.set(amountQueryKey, amount)
  }

  if (clearRecipient) {
    searchParams.delete('recipient')
    searchParams.delete('recipientAddress')
  }

  if (targetChainId) {
    searchParams.set('targetChainId', targetChainId.toString())
  } else {
    searchParams.delete('targetChainId')
  }

  return searchParams.toString()
}
