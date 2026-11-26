import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount } from '@ophis/solana-sdk'

import type { NativeSolanaReview } from '../services/trade.service'

export function SolanaQuoteCosts({ review, buySymbol }: { review: NativeSolanaReview; buySymbol: string }): ReactNode {
  const { quote } = review.quote
  const { feeTerms } = quote
  const baseBps = feeTerms?.baseBps
  const maximumCost = BigInt(quote.costs.networkFees) + BigInt(quote.costs.buyTokenAtaCosts)
  const improvementCapBps = feeTerms?.improvementCapBps
  return (
    <>
      <dt>
        <Trans>Ophis base fee in the buy token</Trans>
      </dt>
      <dd>{formatOphisSolanaAmount(BigInt(quote.costs.protocolFee), review.buy.decimals)}</dd>
      {feeTerms && (
        <>
          <dt>
            <Trans>Base rate</Trans>
          </dt>
          <dd>
            <Trans>{baseBps} bp</Trans>
          </dd>
          <dt>
            <Trans>Ophis share of price improvement</Trans>
          </dt>
          <dd>
            <Trans>50%, capped at {improvementCapBps} bp of the trade</Trans>
          </dd>
        </>
      )}
      <dt>
        <Trans>Maximum settlement cost in {buySymbol}</Trans>
      </dt>
      <dd>
        {formatOphisSolanaAmount(maximumCost, review.buy.decimals)} {buySymbol}
      </dd>
      <dt>
        <Trans>Total quote costs in the buy token</Trans>
      </dt>
      <dd>{formatOphisSolanaAmount(BigInt(quote.costs.total), review.buy.decimals)}</dd>
      {review.solAfterOrder !== undefined && (
        <>
          <dt>
            <Trans>Estimated SOL left after placing the order</Trans>
          </dt>
          <dd>{formatOphisSolanaAmount(review.solAfterOrder, 9)} SOL</dd>
        </>
      )}
    </>
  )
}
