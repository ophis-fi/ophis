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
  if (quote.inputToken) return quote.route.label
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
  if (insufficient) return t`Insufficient balance`
  if (submitted) return t`Swap submitted`
  if (!reviewed) return t`Review swap`
  return expired ? t`Quote expired — review again` : t`Confirm swap`
}

export function WholeTokenRoute({
  quote: shown,
  requestKey,
  reviewed,
  review,
  refresh,
}: {
  quote: DirectQuote
  requestKey: string
  reviewed: boolean
  review: (quote: DirectQuote | null) => void
  refresh: () => Promise<unknown>
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
  return (
    <Card aria-label={t`Best MPS route`}>
      <p>
        <strong>{routeLabel(shown)}</strong> · {t`Exact output`}
      </p>
      <RouteDetails shown={shown} impact={priceImpact.impact} />
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
            if (shown.needsApproval) {
              if (await execution.approve(shown)) {
                review(null)
                await refresh()
              }
              return
            }
            if (!reviewed) return review(shown)
            if (priceImpact.allowed && (await priceImpact.confirm())) await execution.execute(shown)
          }}
        >
          {shown.needsApproval && !execution.pending
            ? t`Approve USDC`
            : buttonText(execution.pending, insufficient, submitted, reviewed, expired)}
        </ButtonPrimary>
      )}
      {reviewed && !execution.pending && (
        <ButtonSecondary onClick={() => review(null)}>{t`Back to quotes`}</ButtonSecondary>
      )}
    </Card>
  )
}

function RouteDetails({
  shown,
  impact,
}: {
  shown: DirectQuote
  impact: ReturnType<typeof useDirectPriceImpact>['impact']
}): ReactNode {
  const { inputCurrency } = useSwapDerivedState()
  const totalInput = shown.totalCost - (shown.inputToken ? shown.gasCostInInput || 0n : 0n)
  const total = inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, totalInput.toString())
  const displayInput = (amount: bigint): string =>
    shown.inputToken ? formatUnits(amount, inputCurrency?.decimals) : displayEth(amount)
  const symbol = inputCurrency?.symbol
  const { value: fiat } = useUsdAmount(total)
  const fees = shown.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  return (
    <dl>
      <dt>{t`You receive`}</dt>
      <dd>{shown.buyAmount.toString()} MPS</dd>
      <dt>{t`Expected input`}</dt>
      <dd>
        {displayInput(shown.sellAmount)} {symbol}
      </dd>
      <dt>{t`Fees`}</dt>
      <dd>
        {displayInput(fees)} {symbol}
      </dd>
      <dt>{t`Estimated gas`}</dt>
      <dd>{displayEth(shown.gasCost)} ETH</dd>
      <dt>{t`Estimated total`}</dt>
      <dd>
        {displayInput(totalInput)} {symbol} {fiat && `(≈ $${fiat.toFixed(2)})`}
      </dd>
      <dt>{shown.inputToken ? t`Maximum input` : t`Maximum total, including gas`}</dt>
      <dd>
        {displayInput(shown.maxTotal)} {symbol}
      </dd>
      {!!shown.approvalGas && (
        <>
          <dt>{t`Estimated approval gas`}</dt>
          <dd>{displayEth(shown.approvalGas * ((shown.maxFeePerGas + shown.maxPriorityFeePerGas) / 2n))} ETH</dd>
        </>
      )}
      {shown.usdcRefund > 0n && (
        <>
          <dt>{t`Expected USDC returned`}</dt>
          <dd>{formatUnits(shown.usdcRefund, 6)} USDC</dd>
        </>
      )}
      <dt>{t`Price impact`}</dt>
      <dd>{impact ? `${impact.toFixed(2)}%` : t`Unavailable`}</dd>
      <dt>{t`Slippage tolerance`}</dt>
      <dd>{shown.slippageBps / 100}%</dd>
    </dl>
  )
}
