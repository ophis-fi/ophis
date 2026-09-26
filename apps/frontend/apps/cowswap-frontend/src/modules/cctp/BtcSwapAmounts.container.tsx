import { ReactNode } from 'react'

import { ARC_CHAIN_ID, NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { Currency, CurrencyAmount, Token } from '@cowprotocol/currency'

import { WBTC_ETHEREUM } from 'entities/cctp'

import { TokenAmountDisplay } from 'modules/bridge'
import { useUsdAmount } from 'modules/usdAmount'

import { type BtcSwapQuote } from './btcSwapQuote.service'
import { cctpToken } from './cctpAssets.const'

const wbtc = new Token(1, WBTC_ETHEREUM, 8, 'WBTC')
const cirbtc = new Token(ARC_CHAIN_ID, cctpToken(ARC_CHAIN_ID, 'cirBTC'), 8, 'cirBTC')

export function BtcSwapAmounts({ quote }: { quote: BtcSwapQuote }): ReactNode {
  const sell = CurrencyAmount.fromRawAmount(wbtc, quote.swap.orderToSign.sellAmount)
  const receive = CurrencyAmount.fromRawAmount(cirbtc, quote.swap.orderToSign.buyAmount)
  const fee = quote.bridge.expanded
    ? CurrencyAmount.fromRawAmount(NATIVE_CURRENCIES[1], quote.bridge.expanded.feeTotalAmount)
    : null
  return (
    <dl>
      <BtcRouteAmount label="You pay" amount={sell} />
      <BtcRouteAmount label="Minimum received on Arc" amount={receive} />
      <BtcRouteAmount label="Estimated bridge fee" amount={fee} />
    </dl>
  )
}

function BtcRouteAmount({ label, amount }: { label: string; amount: CurrencyAmount<Currency> | null }): ReactNode {
  const usdValue = useUsdAmount(amount).value
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <TokenAmountDisplay displaySymbol currencyAmount={amount} usdValue={usdValue} />
      </dd>
    </>
  )
}
