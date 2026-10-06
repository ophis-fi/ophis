import { ReactNode } from 'react'

import { NATIVE_CURRENCIES, USDC_MAINNET } from '@cowprotocol/common-const'
import { useCopyClipboard } from '@cowprotocol/common-hooks'
import { TargetChainId } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { formatUnits, parseUnits } from '@ethersproject/units'

import { Copy, Check } from 'lucide-react'

import { TokenAmountDisplay } from 'modules/bridge'

import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearToken, NearTransfer } from './nearDirect.schemas'
import * as styledEl from './NearQuote.styled'

export function NearQuote({ transfer }: { transfer: NearTransfer }): ReactNode {
  const {
    source,
    destination,
    receipt,
    response: { quote, quoteRequest },
  } = transfer
  const refundFee = transfer.status === 'REFUNDED' ? receipt?.refundFee : quote.refundFee
  return (
    <styledEl.Quote aria-label="Swap summary">
      <QuoteAmount label="You pay" token={source} amount={quote.amountIn} usdValue={quote.amountInUsd} />
      <QuoteAmount label="You receive" token={destination} amount={quote.amountOut} usdValue={quote.amountOutUsd} />
      <styledEl.Details>
        <dt>Minimum received</dt>
        <dd>
          {formatUnits(quote.minAmountOut, destination.decimals)} {destination.symbol}
        </dd>
        <dt>Slippage</dt>
        <dd>{quoteRequest.slippageTolerance / 100}%</dd>
        <dt>Swap fees · included</dt>
        <dd>{(quoteRequest.appFees ?? []).reduce((total, fee) => total + fee.fee, 0) / 100}%</dd>
        {quote.withdrawFee && (
          <>
            <dt>Withdrawal fee · included</dt>
            <dd>
              <FeeAmount token={destination} amount={quote.withdrawFee} />
            </dd>
          </>
        )}
        {refundFee && (
          <>
            <dt>{transfer.status === 'REFUNDED' ? 'Refund fee' : 'Fee if refunded'}</dt>
            <dd>
              <FeeAmount token={source} amount={refundFee} />
            </dd>
          </>
        )}
        <dt>Estimated processing</dt>
        <dd>~{Math.max(1, Math.ceil(quote.timeEstimate / 60))} min</dd>
      </styledEl.Details>
      <small>
        Output includes provider and Ophis fees. Source network fees are paid separately. Processing starts after your
        deposit is confirmed; network confirmations can take longer.
      </small>
      <QuoteAddress
        label={`Receiving address · ${DIRECT_NEAR_CHAINS[destination.blockchain]?.label}`}
        address={quoteRequest.recipient}
      />
      <QuoteAddress
        label={`Refund address · ${DIRECT_NEAR_CHAINS[source.blockchain]?.label}`}
        address={quoteRequest.refundTo}
      />
      {source.contractAddress && <QuoteAddress label="Sending token contract" address={source.contractAddress} />}
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
      {transfer.status === 'REFUNDED' && receipt?.refundReason === 'INTENT_SUBMIT_FAILED' && (
        <p>The provider could not execute the swap. Your deposit was refunded, less the refund fee.</p>
      )}
      {receipt?.destinationChainTxHashes.map(({ hash }) => (
        <QuoteAddress
          key={hash}
          label={transfer.status === 'REFUNDED' ? 'Refund transaction' : 'Destination transaction'}
          address={hash}
        />
      ))}
    </styledEl.Quote>
  )
}

function QuoteAmount({
  label,
  token,
  amount,
  usdValue,
}: {
  label: string
  token: NearToken
  amount: string
  usdValue: string
}): ReactNode {
  return (
    <styledEl.Amount>
      <span>
        {label} · {DIRECT_NEAR_CHAINS[token.blockchain]?.label}
      </span>
      <TokenAmountDisplay displaySymbol currencyAmount={displayAmount(token, amount)} usdValue={displayUsd(usdValue)} />
    </styledEl.Amount>
  )
}

function FeeAmount({ token, amount }: { token: NearToken; amount: string }): ReactNode {
  const exact = formatUnits(amount, token.decimals)
  const rounded = displayAmount(token, amount).toSignificant(6)
  return (
    <span title={`${exact} ${token.symbol}`}>
      {Number(exact) !== Number(rounded) ? '≈ ' : ''}
      {rounded} {token.symbol}
    </span>
  )
}

function QuoteAddress({ label, address }: { label: string; address: string }): ReactNode {
  const [copied, copy] = useCopyClipboard()
  return (
    <styledEl.Address>
      <span>{label}</span>
      <button type="button" aria-label={copied ? `Copied ${label}` : `Copy ${label}`} onClick={() => copy(address)}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      <code>{address}</code>
    </styledEl.Address>
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
