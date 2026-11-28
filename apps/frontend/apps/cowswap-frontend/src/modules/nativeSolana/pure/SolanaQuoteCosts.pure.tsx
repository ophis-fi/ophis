import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount } from '@ophis/solana-sdk'
import { VerifiedAssetBadge, type Verification } from 'entities/verifiedAsset'
import { ChevronDown } from 'react-feather'

import * as amountStyles from 'common/pure/CurrencyAmountPreview/styled'

import { AssetIcon } from './AssetPicker.pure'
import * as styledEl from './NativeSolana.styled'

import { returnedStorageDeposit } from '../services/receipt.service'
import { minimumSolanaBuyAmount, type NativeSolanaReview } from '../services/trade.service'

import type { SolanaAsset } from '../services/assets.service'

export function SolanaQuoteAmount({
  label,
  asset,
  amount,
  verified,
}: {
  label: ReactNode
  asset: SolanaAsset
  amount: string
  verified: Verification | undefined
}): ReactNode {
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

function formatBuyAmount(amount: bigint | string, decimals: number, symbol: string): string {
  return formatOphisSolanaAmount(BigInt(amount), decimals) + ' ' + symbol
}

function NativeQuoteFees({ review }: { review: NativeSolanaReview }): ReactNode {
  const { nativeProtocolFee, buyAmount } = review.quote.quote
  if (!nativeProtocolFee) return null
  const fee = BigInt(nativeProtocolFee.estimatedLamports)
  const net = review.form.buyMint === 'SOL' ? BigInt(buyAmount) - fee : undefined
  return (
    <>
      <dt>
        <Trans>Estimated Ophis fee</Trans>
      </dt>
      <dd>{formatBuyAmount(fee, 9, 'SOL')}</dd>
      {net !== undefined && (
        <>
          <dt>
            <Trans>Estimated SOL after the Ophis fee</Trans>
          </dt>
          <dd>
            {net < 0n ? '−' : ''}
            {formatBuyAmount(net < 0n ? -net : net, 9, 'SOL')}
          </dd>
        </>
      )}
    </>
  )
}

export function SolanaQuoteCosts({ review, buySymbol }: { review: NativeSolanaReview; buySymbol: string }): ReactNode {
  const { costs } = review.quote.quote
  const { decimals } = review.buy
  const minimum = formatBuyAmount(minimumSolanaBuyAmount(review), decimals, buySymbol)
  const atomic = review.atomic?.costs
  return (
    <>
      <styledEl.QuoteValues>
        <dt>
          <Trans>Minimum received</Trans>
        </dt>
        <dd title={review.buy.address}>{minimum}</dd>
        <NativeQuoteFees review={review} />
        {atomic ? (
          <>
            <dt>
              <Trans>Solana network fee</Trans>
            </dt>
            <dd>{formatOphisSolanaAmount(atomic.networkFee, 9)} SOL</dd>
          </>
        ) : (
          <>
            <dt>
              <Trans>Maximum settlement cost in {buySymbol}</Trans>
            </dt>
            <dd>{formatBuyAmount(BigInt(costs.networkFees) + BigInt(costs.buyTokenAtaCosts), decimals, buySymbol)}</dd>
          </>
        )}
      </styledEl.QuoteValues>
      <QuoteFeeDetails review={review} buySymbol={buySymbol} />
    </>
  )
}

function QuoteFeeDetails({ review, buySymbol }: { review: NativeSolanaReview; buySymbol: string }): ReactNode {
  const { feeTerms, costs, nativeProtocolFee } = review.quote.quote
  const { decimals } = review.buy
  const share = feeTerms && feeTerms.improvementShareBps / 100
  const cap = feeTerms && feeTerms.improvementCapBps / 100
  const atomic = review.atomic?.costs
  return (
    <details>
      <summary>
        <Trans>Fee details</Trans>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <styledEl.QuoteValues>
        {nativeProtocolFee ? (
          <>
            <dt>
              <Trans>Maximum Ophis fee</Trans>
            </dt>
            <dd>{formatBuyAmount(nativeProtocolFee.maxLamports, 9, 'SOL')}</dd>
          </>
        ) : (
          <>
            <dt>
              <Trans>Ophis base fee</Trans>
            </dt>
            <dd>
              {formatBuyAmount(costs.protocolFee, decimals, buySymbol)}
              {feeTerms && ' (' + feeTerms.baseBps / 100 + '%)'}
            </dd>
          </>
        )}
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
            <dd>{formatOphisSolanaAmount(returnedStorageDeposit(atomic), 9)} SOL</dd>
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
              <Trans>Total quote costs</Trans>
            </dt>
            <dd>{formatBuyAmount(costs.total, decimals, buySymbol)}</dd>
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
  )
}
