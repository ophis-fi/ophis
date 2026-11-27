import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount } from '@ophis/solana-sdk'
import { useAssetVerification, VerifiedAssetBadge } from 'entities/verifiedAsset'
import { ChevronDown } from 'react-feather'

import * as amountStyles from 'common/pure/CurrencyAmountPreview/styled'

import { AssetIcon } from './AssetPicker.pure'
import * as styledEl from './NativeSolana.styled'

import { solanaAssetIdentity, type SolanaAsset } from '../services/assets.service'
import { minimumSolanaBuyAmount, type NativeSolanaReview } from '../services/trade.service'

export function SolanaQuoteAmount({
  label,
  asset,
  amount,
}: {
  label: ReactNode
  asset: SolanaAsset
  amount: string
}): ReactNode {
  const verified = useAssetVerification(solanaAssetIdentity(asset))
  return (
    <amountStyles.Container>
      <div>{label}</div>
      <div>
        <AssetIcon asset={asset} />
      </div>
      <amountStyles.Amount>
        <span title={asset.mint}>
          {amount}{' '}
          <styledEl.QuoteSymbol>
            {asset.symbol}
            <VerifiedAssetBadge verified={verified} />
          </styledEl.QuoteSymbol>
        </span>
      </amountStyles.Amount>
    </amountStyles.Container>
  )
}

export function SolanaQuoteCosts({ review, buySymbol }: { review: NativeSolanaReview; buySymbol: string }): ReactNode {
  const { quote } = review.quote
  const { feeTerms } = quote
  const share = feeTerms && feeTerms.improvementShareBps / 100
  const cap = feeTerms && feeTerms.improvementCapBps / 100
  const atomic = review.atomic?.costs
  const buyAmount = (amount: bigint | string): string =>
    formatOphisSolanaAmount(BigInt(amount), review.buy.decimals) + ' ' + buySymbol
  return (
    <>
      <styledEl.QuoteValues>
        <dt>
          <Trans>Minimum received</Trans>
        </dt>
        <dd title={review.buy.address}>{buyAmount(minimumSolanaBuyAmount(review))}</dd>
        {atomic ? (
          <>
            <dt>
              <Trans>Solana network fee</Trans>
            </dt>
            <dd>{formatOphisSolanaAmount(atomic.networkFee, 9)} SOL</dd>
            {atomic.tokenAccountRent > 0n && (
              <>
                <dt>
                  <Trans>New wallet token account deposit</Trans>
                </dt>
                <dd>{formatOphisSolanaAmount(atomic.tokenAccountRent, 9)} SOL</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>
              <Trans>Maximum settlement cost in {buySymbol}</Trans>
            </dt>
            <dd>{buyAmount(BigInt(quote.costs.networkFees) + BigInt(quote.costs.buyTokenAtaCosts))}</dd>
          </>
        )}
      </styledEl.QuoteValues>
      <details>
        <summary>
          <Trans>Fee details</Trans>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <styledEl.QuoteValues>
          <dt>
            <Trans>Ophis base fee</Trans>
          </dt>
          <dd>
            {buyAmount(quote.costs.protocolFee)}
            {feeTerms && ' (' + feeTerms.baseBps / 100 + '%)'}
          </dd>
          {feeTerms && (
            <>
              <dt>
                <Trans>Ophis share of extra output</Trans>
              </dt>
              <dd>
                <Trans>
                  {share}%, capped at {cap}% of the trade
                </Trans>
              </dd>
            </>
          )}
          {atomic ? (
            <>
              <dt>
                <Trans>Deposit returned in this swap</Trans>
              </dt>
              <dd>{formatOphisSolanaAmount(atomic.orderRent + atomic.nativeWrapRent, 9)} SOL</dd>
            </>
          ) : (
            <>
              <dt>
                <Trans>Total quote costs</Trans>
              </dt>
              <dd>{buyAmount(quote.costs.total)}</dd>
            </>
          )}
          {review.solAfterOrder !== undefined && (
            <>
              <dt>
                <Trans>Estimated SOL left after placing the order</Trans>
              </dt>
              <dd>{formatOphisSolanaAmount(review.solAfterOrder, 9)} SOL</dd>
            </>
          )}
        </styledEl.QuoteValues>
        <small>
          {atomic ? (
            <Trans>Solana charges the network fee if the transaction lands, even if the swap fails.</Trans>
          ) : (
            <Trans>Your wallet pays to place the order and open any required accounts.</Trans>
          )}
        </small>
      </details>
    </>
  )
}
