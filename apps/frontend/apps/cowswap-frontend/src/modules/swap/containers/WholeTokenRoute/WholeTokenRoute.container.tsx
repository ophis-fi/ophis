import { ReactNode } from 'react'

import { useMachineTimeMs } from '@cowprotocol/common-hooks'
import { CurrencyAmount } from '@cowprotocol/currency'
import { ButtonPrimary, ButtonSecondary } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'
import { formatEther, formatUnits } from '@ethersproject/units'

import { t } from '@lingui/core/macro'
import styled from 'styled-components/macro'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { MetamaskTransactionWarning } from 'modules/tradeWidgetAddons'
import { useUsdAmount } from 'modules/usdAmount'

import { useDirectPriceImpact } from '../../hooks/useDirectPriceImpact'
import { useDirectSwap } from '../../hooks/useDirectSwap'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'
import { DirectQuote } from '../../services/wholeToken/router.service'

const Card = styled.section`
  font-size: 14px;
  padding: 8px 4px;
  dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
    gap: 10px;
  }
  dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
  p {
    line-height: 1.5;
  }
`

function routeLabel(quote: DirectQuote): string {
  if (quote.route.viaV2) return t`Uniswap v3 + v2 via USDC`
  return quote.route.tokens.length > 2 ? t`Uniswap v3 via USDC` : quote.route.label
}

function displayEth(amount: bigint): string {
  // Round displayed ceilings up to eight decimals; the transaction uses exact wei.
  return formatEther(((amount + 9999999999n) / 10000000000n) * 10000000000n)
}

function buttonText(
  pending: boolean,
  insufficient: boolean,
  submitted: boolean,
  reviewed: boolean,
  expired: boolean,
): string {
  if (pending) return t`Transaction in progress`
  if (insufficient) return t`Insufficient ETH including gas`
  if (submitted) return t`Swap submitted`
  if (!reviewed) return t`Review swap`
  return expired ? t`Quote expired — review again` : t`Confirm swap`
}

export function WholeTokenRoute({
  quote: shown,
  requestKey,
  reviewed,
  review,
}: {
  quote: DirectQuote
  requestKey: string
  reviewed: boolean
  review: (quote: DirectQuote | null) => void
}): ReactNode {
  const { account } = useWalletInfo()
  const connect = useToggleWalletModal()
  const { inputCurrency, inputCurrencyBalance } = useSwapDerivedState()
  const execution = useDirectSwap(requestKey)
  const priceImpact = useDirectPriceImpact(shown)
  const submitted = execution.submitted === shown
  const now = useMachineTimeMs(1000)
  const expired = now - shown.quotedAt >= 30000
  const insufficient =
    !!account && (!inputCurrencyBalance || BigInt(inputCurrencyBalance.quotient.toString()) < shown.maxTotal)
  const total = inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, shown.totalCost.toString())
  const { value: fiat } = useUsdAmount(total)
  const fees = shown.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  return (
    <Card aria-label={t`Best MPS route`}>
      <p>
        <strong>{routeLabel(shown)}</strong> · {t`Exact output`}
      </p>
      <dl>
        <dt>{t`You receive`}</dt>
        <dd>{shown.buyAmount.toString()} MPS</dd>
        <dt>{t`Expected input`}</dt>
        <dd>{displayEth(shown.sellAmount)} ETH</dd>
        <dt>{t`Fees`}</dt>
        <dd>{displayEth(fees)} ETH</dd>
        <dt>{t`Estimated gas`}</dt>
        <dd>{displayEth(shown.gasCost)} ETH</dd>
        <dt>{t`Estimated total`}</dt>
        <dd>
          {displayEth(shown.totalCost)} ETH {fiat && `(≈ $${fiat.toFixed(2)})`}
        </dd>
        <dt>{t`Maximum total, including gas`}</dt>
        <dd>{displayEth(shown.maxTotal)} ETH</dd>
        {shown.usdcRefund > 0n && (
          <>
            <dt>{t`Expected USDC returned`}</dt>
            <dd>{formatUnits(shown.usdcRefund, 6)} USDC</dd>
          </>
        )}
        <dt>{t`Price impact`}</dt>
        <dd>{priceImpact.impact ? `${priceImpact.impact.toFixed(2)}%` : t`Unavailable`}</dd>
        <dt>{t`Slippage tolerance`}</dt>
        <dd>{shown.slippageBps / 100}%</dd>
      </dl>
      <p>{t`Unused input is returned to your wallet. Gas is paid on Ethereum.`}</p>
      {reviewed && (
        <p>
          {t`Recipient`}: <span style={{ overflowWrap: 'anywhere' }}>{shown.recipient}</span>
        </p>
      )}
      <p role="status">{execution.message}</p>
      {execution.hash && (
        <p>
          <a href={`https://etherscan.io/tx/${execution.hash}`} target="_blank" rel="noreferrer">
            {t`View transaction`}
          </a>
        </p>
      )}
      {inputCurrency && <MetamaskTransactionWarning sellToken={inputCurrency} />}
      {!account ? (
        <ButtonPrimary onClick={connect}>{t`Connect wallet`}</ButtonPrimary>
      ) : (
        <ButtonPrimary
          disabled={
            !priceImpact.allowed ||
            execution.pending ||
            priceImpact.loading ||
            insufficient ||
            submitted ||
            (reviewed && expired)
          }
          onClick={async () => {
            if (!reviewed) return review(shown)
            if (priceImpact.allowed && (await priceImpact.confirm())) await execution.execute(shown)
          }}
        >
          {buttonText(execution.pending, insufficient, submitted, reviewed, expired)}
        </ButtonPrimary>
      )}
      {reviewed && !execution.pending && (
        <ButtonSecondary onClick={() => review(null)}>{t`Back to quotes`}</ButtonSecondary>
      )}
    </Card>
  )
}
