import { useMemo } from 'react'

import { Currency, CurrencyAmount, Token } from '@cowprotocol/currency'

import { useUsdAmount } from 'modules/usdAmount'

import { useShouldPayGas } from './useShouldPayGas'

import { ReceiveAmountInfo } from '../types'
import { getOrderTypeReceiveAmounts } from '../utils/getOrderTypeReceiveAmounts'
import { getTotalCosts } from '../utils/getTotalCosts'

export type NetReceivedKind = 'receive' | 'pay'

export interface NetReceivedUsdInfo {
  /**
   * The net amount in token terms: what the order actually delivers (sell) or
   * spends (buy) after network costs and the Ophis fee. Null when there is no
   * quote or when quoted costs consume the whole output (nothing meaningful to
   * headline), which hides the row instead of showing a negative number.
   */
  netAmount: CurrencyAmount<Currency> | null
  /** USD value of `netAmount`. Null when no USD price is known (native fallback display). */
  netUsd: CurrencyAmount<Token> | null
  /** USD value of the amount before all fees. Null when unpriced (the tooltip row hides). */
  grossUsd: CurrencyAmount<Token> | null
  /** Total quoted costs (network + Ophis fee + bridge) in token terms. */
  totalCosts: CurrencyAmount<Currency> | null
  /** USD value of `totalCosts`. Null when unpriced (the tooltip row hides, never a partial sum). */
  totalCostsUsd: CurrencyAmount<Token> | null
  /**
   * True when the wallet pays gas on top of the quoted amounts (EOA eth-flow or
   * no offchain signing). Gas is never estimated here; the row shows a "+ gas"
   * suffix instead of a number.
   */
  userPaysGasOnTop: boolean
  /** 'receive' for sell orders (net you get), 'pay' for buy orders (net you spend). */
  kind: NetReceivedKind
  isLoading: boolean
}

/**
 * Net-of-costs headline data for the current quote (ux-quoting decision 59).
 *
 * All values derive from amounts the quote already carries: netAmount is
 * `getOrderTypeReceiveAmounts(info).amountAfterFees` (network costs, Ophis fee
 * and bridge fee included), totalCosts is `getTotalCosts(info)`. USD values
 * come from `useUsdAmount`; when a price is missing the corresponding USD
 * field is null and the UI degrades to the token amount (headline) or hides
 * the line (tooltip breakdown) rather than showing a partial sum.
 */
export function useNetReceivedUsd(info: ReceiveAmountInfo | null): NetReceivedUsdInfo {
  const userPaysGasOnTop = useShouldPayGas()

  const { netAmount, grossAmount, totalCosts, kind } = useMemo(() => {
    if (!info) {
      return { netAmount: null, grossAmount: null, totalCosts: null, kind: 'receive' as NetReceivedKind }
    }

    const { amountAfterFees, amountBeforeFees } = getOrderTypeReceiveAmounts(info)

    // On a cross-chain swap getOrderTypeReceiveAmounts subtracts the bridge fee
    // (in destination currency, sell orders only) from the net, but
    // getTotalCosts sums only network + partner + protocol fees. Feed the same
    // bridge amount into getTotalCosts so netAmount == amountBeforeFees -
    // totalCosts holds and the tooltip agrees with the accordion header, which
    // also passes the bridge fee into getTotalCosts (in the swap leg's
    // intermediate currency). Undefined for normal swaps and buy orders, where
    // no bridge amount is deducted from the net, so getTotalCosts is unchanged.
    const bridgeCost = info.isSell ? info.costs.bridgeFee?.amountInDestinationCurrency : undefined

    return {
      // Quoted costs can exceed the output (dust trades, spiking bridge fees):
      // a zero or negative net is not a headline, it is a broken trade, and the
      // quote layer surfaces that error separately. Hide the row.
      netAmount: amountAfterFees.greaterThan(0) ? amountAfterFees : null,
      grossAmount: amountBeforeFees,
      totalCosts: getTotalCosts(info, bridgeCost),
      kind: (info.isSell ? 'receive' : 'pay') as NetReceivedKind,
    }
  }, [info])

  const { value: netUsd, isLoading: netUsdLoading } = useUsdAmount(netAmount)
  const { value: grossUsd, isLoading: grossUsdLoading } = useUsdAmount(grossAmount)
  const { value: totalCostsUsd, isLoading: totalCostsUsdLoading } = useUsdAmount(totalCosts)

  return useMemo(
    () => ({
      netAmount,
      netUsd: netAmount ? netUsd : null,
      grossUsd: netAmount ? grossUsd : null,
      totalCosts,
      totalCostsUsd: netAmount ? totalCostsUsd : null,
      userPaysGasOnTop,
      kind,
      isLoading: netUsdLoading || grossUsdLoading || totalCostsUsdLoading,
    }),
    [
      netAmount,
      netUsd,
      grossUsd,
      totalCosts,
      totalCostsUsd,
      userPaysGasOnTop,
      kind,
      netUsdLoading,
      grossUsdLoading,
      totalCostsUsdLoading,
    ],
  )
}
