import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { isFractionFalsy } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { Nullish } from 'types'

import type { TradeFormValidationContext } from 'modules/tradeFormValidation'
import { getIsXstockTradeBelowLimit } from 'modules/tradeFormValidation/services/getIsXstockTradeBelowLimit'

import { ExtensibleFallbackVerification } from '../../services/verifyExtensibleFallback'
import { TWAPOrder } from '../../types'
import { isPartTimeIntervalTooLong } from '../../utils/isPartTimeIntervalTooLong'
import { isPartTimeIntervalTooShort } from '../../utils/isPartTimeIntervalTooShort'
import { isSellAmountTooSmall } from '../../utils/isSellAmountTooSmall'

export interface TwapFormStateParams {
  isTxBundlingSupported: boolean | null
  verification: ExtensibleFallbackVerification | null
  twapOrder: TWAPOrder | null
  sellAmountPartFiat: Nullish<CurrencyAmount<Currency>>
  chainId: SupportedChainId | undefined
  partTime: number | undefined
  numberOfPartsValue: number
  tradeFormValidationContext: TradeFormValidationContext | null
}

export enum TwapFormState {
  UNSUPPORTED_CHAIN = 'UNSUPPORTED_CHAIN',
  LOADING_SAFE_INFO = 'LOADING_SAFE_INFO',
  TX_BUNDLING_NOT_SUPPORTED = 'TX_BUNDLING_NOT_SUPPORTED',
  SELL_AMOUNT_TOO_SMALL = 'SELL_AMOUNT_TOO_SMALL',
  PART_TIME_INTERVAL_TOO_SHORT = 'PART_TIME_INTERVAL_TOO_SHORT',
  PART_TIME_INTERVAL_TOO_LONG = 'PART_TIME_INTERVAL_TOO_LONG',
  X_STOCK_MIN_TRADE_SIZE = 'X_STOCK_MIN_TRADE_SIZE',
}

export function getTwapFormState(props: TwapFormStateParams): TwapFormState | null {
  const {
    twapOrder,
    isTxBundlingSupported,
    verification,
    sellAmountPartFiat,
    chainId,
    partTime,
    tradeFormValidationContext,
    numberOfPartsValue,
  } = props

  // These chains lack the required TWAP helpers. A non-null state blocks both
  // review and confirmation, including direct URLs to the hidden TWAP page.
  if (chainId !== undefined && [10, 130, 4663, ARC_CHAIN_ID].includes(chainId)) {
    return TwapFormState.UNSUPPORTED_CHAIN
  }

  if (isTxBundlingSupported === false) return TwapFormState.TX_BUNDLING_NOT_SUPPORTED

  if (verification === null || isTxBundlingSupported === null) return TwapFormState.LOADING_SAFE_INFO

  if (!isFractionFalsy(twapOrder?.buyAmount) && isSellAmountTooSmall(sellAmountPartFiat, chainId)) {
    return TwapFormState.SELL_AMOUNT_TOO_SMALL
  }

  // Not using `twapOrder.timeInterval` because it's not filled until the order is ready
  if (isPartTimeIntervalTooShort(partTime)) {
    return TwapFormState.PART_TIME_INTERVAL_TOO_SHORT
  }
  if (isPartTimeIntervalTooLong(partTime)) {
    return TwapFormState.PART_TIME_INTERVAL_TOO_LONG
  }

  if (tradeFormValidationContext) {
    const isXstockTradeBelowLimit = getIsXstockTradeBelowLimit(tradeFormValidationContext, numberOfPartsValue)

    if (isXstockTradeBelowLimit) return TwapFormState.X_STOCK_MIN_TRADE_SIZE
  }

  return null
}
