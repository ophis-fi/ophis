import { useMemo, useState, type ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Callout, Section } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'
import { isAddressEqual } from 'viem'

import { OtcActionControl } from './OtcActionControl.container'
import { OtcUsdValue } from './OtcUsdValue.pure'
import * as styledEl from './OtcWrite.styled'
import { reviewedOtcToken, type OtcReviewedToken } from './otcWriteForm'

import type { OtcActionDefinition } from './useOtcActionController'
import type { OtcOrder } from 'ophis/otc'
import type { Address } from 'viem'

function buildOrderActionDefinition(
  account: Address | undefined,
  order: OtcOrder,
  isMaker: boolean,
  reviewed: boolean,
  paymentToken: OtcReviewedToken | null,
  receivedToken: OtcReviewedToken | null,
): OtcActionDefinition {
  const reviewedTerms = !!paymentToken && !!receivedToken
  return {
    executeLabel: isMaker ? 'Cancel order' : 'Fill entire order',
    ready: order.active && reviewedTerms,
    reviewed,
    resetKey: `${order.orderId.toString()}:${order.active}:${account ?? ''}`,
    executeIntent: account
      ? isMaker
        ? { kind: 'cancel', account, order }
        : { kind: 'fill', account, order, deadline: 1n }
      : null,
    approvalIntent: account && !isMaker ? { kind: 'approve-fill', account, order } : null,
    revokeIntent: account && !isMaker ? { kind: 'revoke-fill', account, order } : null,
    allowanceToken: !isMaker ? order.tokenB : null,
    allowanceTokenDecimals: paymentToken?.decimals,
    allowanceTokenSymbol: paymentToken?.symbol,
    requiredAllowance: !isMaker ? order.amountB : null,
  }
}

function OtcOrderTermsSummary({
  isMaker,
  order,
  paymentToken,
  receivedToken,
}: {
  isMaker: boolean
  order: OtcOrder
  paymentToken: OtcReviewedToken | null
  receivedToken: OtcReviewedToken | null
}): ReactNode {
  if (!paymentToken || !receivedToken) return null
  if (isMaker) {
    return (
      <styledEl.WriteSummary>
        <p>
          Cancellation returns {formatOtcAmount(order.amountA, receivedToken.decimals)} {receivedToken.symbol} from
          escrow.
        </p>
      </styledEl.WriteSummary>
    )
  }
  return (
    <styledEl.WriteSummary>
      <p>
        Pay {formatOtcAmount(order.amountB, paymentToken.decimals)} {paymentToken.symbol}.
      </p>
      <OtcUsdValue token={paymentToken} amount={order.amountB} />
      <p>
        Receive {formatOtcAmount(order.amountA, receivedToken.decimals)} {receivedToken.symbol}.
      </p>
      <OtcUsdValue token={receivedToken} amount={order.amountA} />
      <p>The fill uses a fresh three-minute deadline and may lose an Ethereum race.</p>
    </styledEl.WriteSummary>
  )
}

export function OtcOrderActionPanel({ order, onConfirmed }: { order: OtcOrder; onConfirmed?: () => void }): ReactNode {
  const { account } = useWalletInfo()
  const [reviewed, setReviewed] = useState(false)
  const isMaker = !!account && isAddressEqual(account, order.maker)
  const paymentToken = reviewedOtcToken(order.tokenB)
  const receivedToken = reviewedOtcToken(order.tokenA)
  const definition = useMemo(
    () => buildOrderActionDefinition(account, order, isMaker, reviewed, paymentToken, receivedToken),
    [account, isMaker, order, paymentToken, receivedToken, reviewed],
  )

  return (
    <Section id="otc-order-action" title={isMaker ? 'Cancel order on local fork' : 'Fill order on local fork'}>
      <Callout tone="warning" title="Fork-only transaction mode">
        <p>Preflight re-reads these exact terms and simulates the call before your wallet is asked to submit.</p>
      </Callout>
      <OtcOrderTermsSummary isMaker={isMaker} order={order} paymentToken={paymentToken} receivedToken={receivedToken} />
      <styledEl.ReviewLabel>
        <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
        {isMaker
          ? 'I reviewed the exact order and understand cancellation costs Ethereum gas.'
          : 'I reviewed both exact token amounts, allowance, escrow risks, and race risk.'}
      </styledEl.ReviewLabel>
      <OtcActionControl definition={definition} onConfirmed={onConfirmed} />
    </Section>
  )
}
