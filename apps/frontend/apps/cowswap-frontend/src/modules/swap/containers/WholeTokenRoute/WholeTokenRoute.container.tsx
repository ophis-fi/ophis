import { ReactNode } from 'react'

import { useNativeTokenBalance } from '@cowprotocol/balances-and-allowances'
import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { useMachineTimeMs } from '@cowprotocol/common-hooks'
import { ButtonPrimary } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { t } from '@lingui/core/macro'
import styled from 'styled-components/macro'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { TradeFormButtons, useTradeFormButtonContext } from 'modules/tradeFormValidation'
import { MetamaskTransactionWarning } from 'modules/tradeWidgetAddons'

import { WholeTokenRouteDetails } from './WholeTokenRouteDetails.container'
import { WholeTokenWarnings } from './WholeTokenWarnings.pure'

import { useDirectPriceImpact } from '../../hooks/useDirectPriceImpact'
import { useDirectSwap } from '../../hooks/useDirectSwap'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'
import { directChainId, DirectQuote } from '../../services/wholeToken/router.service'
import { canFundDirect } from '../../services/wholeToken/selection.service'

const Card = styled.section`
  display: flex;
  flex-direction: column;
  gap: 12px;
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
`

export interface WholeTokenRouteProps {
  quote: DirectQuote
  requestKey: string
  reviewed: boolean
  review: (quote: DirectQuote | null) => void
  refresh: () => Promise<unknown>
}

export function WholeTokenRoute(props: WholeTokenRouteProps): ReactNode {
  const priceImpact = useDirectPriceImpact(props.quote)
  return (
    <Card aria-label={t`MPS quote`}>
      <WholeTokenRouteDetails shown={props.quote} impact={priceImpact.impact} />
      <WholeTokenWarnings quote={props.quote} impact={priceImpact.impact} loading={priceImpact.loading} />
      <RouteAction {...props} priceImpact={priceImpact} />
    </Card>
  )
}

function RouteAction({
  quote,
  requestKey,
  reviewed,
  review,
  refresh,
  priceImpact,
}: WholeTokenRouteProps & {
  priceImpact: ReturnType<typeof useDirectPriceImpact>
}): ReactNode {
  const { account } = useWalletInfo()
  const { data: nativeBalance, error: balanceError } = useNativeTokenBalance(account, directChainId(quote))
  const funded = canFundDirect(quote, !!account, nativeBalance ? BigInt(nativeBalance.toString()) : undefined)
  const nativeSymbol = NATIVE_CURRENCIES[directChainId(quote)].symbol
  const gasError = gasErrorText(funded, !!nativeBalance, !!balanceError, nativeSymbol)
  const connect = useToggleWalletModal()
  const { inputCurrency, inputCurrencyBalance } = useSwapDerivedState()
  const execution = useDirectSwap(requestKey)
  const submitted = execution.submitted === quote
  const now = useMachineTimeMs(1000)
  const expired = now - quote.quotedAt >= 30000
  const insufficient =
    !!account && (!inputCurrencyBalance || BigInt(inputCurrencyBalance.quotient.toString()) < quote.maxTotal)
  const onClick = async (): Promise<void> => {
    if (expired) {
      review(null)
      await refresh()
    } else if (quote.needsApproval) {
      if (await execution.approve(quote)) {
        review(null)
        await refresh()
      }
    } else if (!reviewed) review(quote)
    else if (priceImpact.allowed && (await priceImpact.confirm())) await execution.execute(quote)
  }
  const context = useTradeFormButtonContext(t`Confirm swap`, onClick)
  const disabled = [
    execution.pending,
    submitted,
    !expired && [!priceImpact.allowed, priceImpact.loading, insufficient, !funded].some(Boolean),
  ].some(Boolean)
  const label = buttonText(
    execution.pending,
    submitted,
    expired,
    insufficient ? t`Insufficient balance` : gasError,
    priceImpact,
    quote.needsApproval,
    reviewed,
    inputCurrency?.symbol || '',
  )
  return (
    <>
      {execution.message && <p role="status">{execution.message}</p>}
      {execution.hash && (
        <a
          href={`https://${quote.chainId === 100 ? 'gnosisscan.io' : 'etherscan.io'}/tx/${execution.hash}`}
          target="_blank"
          rel="noreferrer"
        >{t`View transaction`}</a>
      )}
      {inputCurrency && <MetamaskTransactionWarning sellToken={inputCurrency} />}
      {!account ? (
        <ButtonPrimary onClick={connect}>{t`Connect wallet`}</ButtonPrimary>
      ) : !expired && !execution.pending && !submitted && priceImpact.validation !== null && context ? (
        <TradeFormButtons
          validation={priceImpact.validation}
          context={context}
          confirmText={t`Confirm swap`}
          isDisabled
        />
      ) : (
        <ButtonPrimary disabled={disabled} onClick={onClick}>
          {label}
        </ButtonPrimary>
      )}
    </>
  )
}

function gasErrorText(funded: boolean, hasBalance: boolean, failed: boolean, nativeSymbol = ''): string {
  if (funded) return ''
  if (hasBalance) return t`Insufficient ${nativeSymbol} for gas`
  return failed ? t`Unable to check gas balance` : t`Checking gas balance`
}

function buttonText(
  pending: boolean,
  submitted: boolean,
  expired: boolean,
  fundingError: string,
  priceImpact: ReturnType<typeof useDirectPriceImpact>,
  needsApproval: boolean | undefined,
  reviewed: boolean,
  symbol: string,
): string {
  if (pending) return t`Transaction in progress`
  if (submitted) return t`Swap submitted`
  if (expired) return t`Refresh quote`
  if (fundingError) return fundingError
  if (priceImpact.loading) return t`Fetching price impact`
  if (!priceImpact.allowed) return t`Preparing swap`
  if (needsApproval) return t`Approve ${symbol}`
  return reviewed ? t`Confirm swap` : t`Review swap`
}
