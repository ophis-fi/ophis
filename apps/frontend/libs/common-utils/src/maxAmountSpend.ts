import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import JSBI from 'jsbi'

import { getIsNativeToken } from './getIsNativeToken'

const MIN_NATIVE_CURRENCY_FOR_GAS: JSBI = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(16)) // .01 ETH

/**
 * Given some token amount, return the max that can be spent of it
 * @param currencyAmount to return max of
 * @param canUseAllNative whether or not the use can use all the native currency, if native
 */
export function maxAmountSpend(
  currencyAmount?: CurrencyAmount<Currency>,
  canUseAllNative?: boolean,
): CurrencyAmount<Currency> | undefined {
  if (!currencyAmount) return undefined
  const arcUsdc =
    currencyAmount.currency.chainId === ARC_CHAIN_ID &&
    'address' in currencyAmount.currency &&
    areAddressesEqual(currencyAmount.currency.address, ARC_USDC_ADDRESS)
  // ponytail: reserve 1 USDC for local approval/cancel gas; use a live fee estimate before mainnet enablement.
  const reserve = arcUsdc ? JSBI.BigInt(1_000_000) : MIN_NATIVE_CURRENCY_FOR_GAS
  if (arcUsdc || (getIsNativeToken(currencyAmount.currency) && !canUseAllNative)) {
    if (JSBI.greaterThan(currencyAmount.quotient, reserve)) {
      return CurrencyAmount.fromRawAmount(currencyAmount.currency, JSBI.subtract(currencyAmount.quotient, reserve))
    } else {
      return CurrencyAmount.fromRawAmount(currencyAmount.currency, JSBI.BigInt(0))
    }
  }
  return currencyAmount
}
