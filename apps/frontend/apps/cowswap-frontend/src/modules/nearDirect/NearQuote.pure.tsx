import { ReactNode } from 'react'

import { NATIVE_CURRENCIES, USDC_MAINNET } from '@cowprotocol/common-const'
import { TargetChainId } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { formatUnits, parseUnits } from '@ethersproject/units'

import { TokenAmountDisplay } from 'modules/bridge'

import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearToken, NearTransfer } from './nearDirect.schemas'
import * as styledEl from './nearDirect.styled'

export function NearQuote({ transfer }: { transfer: NearTransfer }): ReactNode {
  const {
    source,
    destination,
    receipt,
    response: { quote, quoteRequest },
  } = transfer
  return (
    <styledEl.Quote>
      <styledEl.QuoteAmount>
        <span>Send on {DIRECT_NEAR_CHAINS[source.blockchain]?.label}</span>
        <TokenAmountDisplay
          displaySymbol
          currencyAmount={displayAmount(source, quote.amountIn)}
          usdValue={displayUsd(quote.amountInUsd)}
        />
      </styledEl.QuoteAmount>
      {source.contractAddress && (
        <small>
          Sending token: <code>{source.contractAddress}</code>
        </small>
      )}
      <styledEl.QuoteAmount>
        <span>Receive on {DIRECT_NEAR_CHAINS[destination.blockchain]?.label} (estimated)</span>
        <TokenAmountDisplay
          displaySymbol
          currencyAmount={displayAmount(destination, quote.amountOut)}
          usdValue={displayUsd(quote.amountOutUsd)}
        />
      </styledEl.QuoteAmount>
      <small>
        Minimum received: {formatUnits(quote.minAmountOut, destination.decimals)} {destination.symbol}. Slippage: 1%.
        Output includes provider and Ophis fees. Source network fees are paid separately.
      </small>
      <small>
        Quoted swap fees: {(quoteRequest.appFees ?? []).reduce((total, fee) => total + fee.fee, 0) / 100}% (included
        above).
      </small>
      {quote.withdrawFee && (
        <small>
          Included withdrawal fee: {formatUnits(quote.withdrawFee, destination.decimals)} {destination.symbol}
        </small>
      )}
      {quote.refundFee && (
        <small>
          Fee if refunded: {formatUnits(quote.refundFee, source.decimals)} {source.symbol}
        </small>
      )}
      <p>
        Receiving address: <code>{quoteRequest.recipient}</code>
      </p>
      <p>
        Refund address ({DIRECT_NEAR_CHAINS[source.blockchain]?.label}): <code>{quoteRequest.refundTo}</code>
      </p>
      <small>
        Estimated processing: {Math.ceil(quote.timeEstimate / 60)} min after the source deposit is confirmed. Network
        confirmations can take longer.
      </small>
      {transfer.status === 'SUCCESS' && receipt?.amountOut && (
        <p>
          Delivered: {formatUnits(receipt.amountOut, destination.decimals)} {destination.symbol}
        </p>
      )}
      {receipt?.refundedAmount && BigInt(receipt.refundedAmount) > 0n && (
        <p>
          Refunded: {formatUnits(receipt.refundedAmount, source.decimals)} {source.symbol}
        </p>
      )}
      {receipt?.destinationChainTxHashes.map(({ hash }) => (
        <p key={hash}>
          Destination transaction: <code>{hash}</code>
        </p>
      ))}
    </styledEl.Quote>
  )
}

function displayAmount(token: NearToken, amount: string): CurrencyAmount<Token> {
  const id = DIRECT_NEAR_CHAINS[token.blockchain]?.id ?? 0
  const address = token.contractAddress ?? NATIVE_CURRENCIES[id as TargetChainId]?.address ?? token.assetId
  return CurrencyAmount.fromRawAmount(new Token(id, address, token.decimals, token.symbol), amount)
}
function displayUsd(value: string): CurrencyAmount<Token> {
  return CurrencyAmount.fromFractionalAmount(USDC_MAINNET, parseUnits(value, 18).toString(), '1000000000000')
}
