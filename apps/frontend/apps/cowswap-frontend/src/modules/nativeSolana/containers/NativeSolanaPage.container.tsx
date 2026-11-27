import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { ButtonPrimary } from '@cowprotocol/ui'

import { Trans, useLingui } from '@lingui/react/macro'
import { formatOphisSolanaAmount } from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { Callout, PageShell } from 'ophis/ds'
import { ArrowLeft } from 'react-feather'
import { Navigate } from 'react-router'

import { SOLANA_SWAP_URL } from 'common/constants/routes'
import { SwapAmountPair } from 'common/pure/CurrencyAmountPreview/SwapAmountPair.pure'

import { NativeSolanaForm } from './NativeSolanaForm.container'
import { NativeSolanaOrders } from './NativeSolanaOrders.container'

import * as styledEl from '../pure/NativeSolana.styled'
import { SolanaQuoteAmount, SolanaQuoteCosts } from '../pure/SolanaQuoteCosts.pure'
import * as receiptStyles from '../pure/SolanaReceipt.styled'
import * as formStyles from '../pure/SwapForm.styled'
import { unknownAsset } from '../services/assets.service'
import { privateModeAtom, privateSettlementEnabled } from '../services/privateSettlement.service'
import { walletAssetListAtom } from '../state/assets.atoms'
import { createNativeSolanaOrderAtom } from '../state/placeOrder.atoms'
import {
  clearNativeSolanaReviewAtom,
  nativeSolanaBusyAtom,
  nativeSolanaErrorAtom,
  nativeSolanaReviewAtom,
} from '../state/trade.atoms'

function PrivateOrderNotice({
  sellsNative,
  sellAmount,
  buySymbol,
}: {
  sellsNative: boolean
  sellAmount: string
  buySymbol: string
}): ReactNode {
  const { automatic: auto, requiredVenue, walletChoice } = useAtomValue(privateModeAtom).data ?? {}
  return (
    <p>
      {requiredVenue ? (
        <Trans>
          Backpack places one order. It can settle only if {requiredVenue} wins. An unfilled order can expire, and you
          can reclaim its account rent.
        </Trans>
      ) : walletChoice ? (
        <Trans>
          Backpack places this order with your selected minimum. The private auction can settle it once. If it expires,
          you can reclaim the order rent.
        </Trans>
      ) : auto ? (
        <Trans>
          Backpack places this order. The Ophis solver then settles it automatically, even if you close this page.
        </Trans>
      ) : sellsNative ? (
        <Trans>
          The first approval wraps {sellAmount} SOL in your wallet and places your order. You receive {buySymbol} after
          you approve settlement. If the order expires, the wSOL stays in your wallet.
        </Trans>
      ) : (
        <Trans>The first approval places your order. You receive {buySymbol} after you approve settlement.</Trans>
      )}
    </p>
  )
}

function AllowanceNotice({
  atoms,
  decimals,
  symbol,
  delegate,
}: {
  atoms: bigint
  decimals: number
  symbol: string
  delegate: string
}): ReactNode {
  const amount = formatOphisSolanaAmount(atoms, decimals)
  return (
    <Trans>
      Replace the existing allowance of {amount} {symbol} for {delegate}. Older orders using this allowance may stop
      filling.
    </Trans>
  )
}

function NativeSolanaReview({ onBack }: { onBack(): void }): ReactNode {
  const { t } = useLingui()
  const review = useAtomValue(nativeSolanaReviewAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const [acceptedReview, setAcceptedReview] = useState<typeof review>(null)
  const create = useSetAtom(createNativeSolanaOrderAtom)
  const assets = useAtomValue(walletAssetListAtom)
  if (!review) return null
  const sell = assets.find((asset) => asset.mint === review.form.sellMint) ?? unknownAsset(review.form.sellMint)
  const buy = assets.find((asset) => asset.mint === review.form.buyMint) ?? unknownAsset(review.form.buyMint)
  const { quote } = review.quote
  const sellAmount = formatOphisSolanaAmount(BigInt(quote.sellAmount) + BigInt(quote.feeAmount), review.sell.decimals)
  return (
    <receiptStyles.Receipt aria-label={t`Review your swap`}>
      <styledEl.Row>
        <formStyles.Back type="button" aria-label={t`Back`} onClick={onBack} disabled={busy}>
          <ArrowLeft size={18} aria-hidden="true" />
        </formStyles.Back>
        <h2>
          <Trans>Review your swap</Trans>
        </h2>
      </styledEl.Row>
      <SwapAmountPair
        sell={<SolanaQuoteAmount label={<Trans>You sell</Trans>} asset={sell} amount={sellAmount} />}
        buy={
          <SolanaQuoteAmount
            label={<Trans>You receive</Trans>}
            asset={buy}
            amount={formatOphisSolanaAmount(BigInt(quote.buyAmount), review.buy.decimals)}
          />
        }
      />
      <SolanaQuoteCosts review={review} buySymbol={buy.symbol} />
      {!review.atomic && privateSettlementEnabled && (
        <PrivateOrderNotice
          sellsNative={review.form.sellMint === 'SOL'}
          sellAmount={sellAmount}
          buySymbol={buy.symbol}
        />
      )}
      {review.allowance && (
        <label>
          <input
            type="checkbox"
            checked={acceptedReview === review}
            onChange={(event) => setAcceptedReview(event.target.checked ? review : null)}
          />
          <AllowanceNotice
            atoms={review.allowance.atoms}
            decimals={review.sell.decimals}
            symbol={sell.symbol}
            delegate={review.allowance.delegate}
          />
        </label>
      )}
      <ButtonPrimary
        type="button"
        disabled={busy || (!!review.allowance && acceptedReview !== review)}
        onClick={() => void create(acceptedReview === review)}
      >
        <Trans>Confirm in wallet</Trans>
      </ButtonPrimary>
    </receiptStyles.Receipt>
  )
}

export function NativeSolanaWidget(): ReactNode {
  const wallet = useAtomValue(solanaConnectionAtom)
  const review = useAtomValue(nativeSolanaReviewAtom)
  const [selected, setSelected] = useState<typeof review>(null)
  const clearQuote = useSetAtom(clearNativeSolanaReviewAtom)
  const clearError = useSetAtom(nativeSolanaErrorAtom)
  const error = useAtomValue(nativeSolanaErrorAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  useEffect(() => {
    if (!review || busy) return
    const timer = window.setTimeout(() => clearQuote(), Math.max(0, Date.parse(review.quote.expiration) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [review, busy, clearQuote])
  return (
    <styledEl.Stack>
      <NativeSolanaOrders>
        {selected && selected === review ? (
          <NativeSolanaReview
            onBack={() => {
              clearError(null)
              setSelected(null)
            }}
          />
        ) : (
          <NativeSolanaForm
            key={wallet?.account.address}
            onReview={(current) => {
              clearError(null)
              setSelected(current)
            }}
          />
        )}
      </NativeSolanaOrders>
      {busy && (
        <p role="status">
          <Trans>Preparing your trade. Check your wallet for any approval request.</Trans>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </styledEl.Stack>
  )
}

export function NativeSolanaPage(): ReactNode {
  if (OPHIS_SOLANA_CONFIG) return <Navigate to={SOLANA_SWAP_URL} replace />
  return (
    <PageShell eyebrow="Solana" title={<Trans>Swap on Solana.</Trans>}>
      <Callout title={<Trans>Solana trading is being prepared</Trans>} tone="info">
        <p>
          <Trans>Trading will be available here when the Ophis Solana service is ready.</Trans>
        </p>
      </Callout>
    </PageShell>
  )
}
