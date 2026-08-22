import { useMemo, useState, type ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Callout, Section } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'
import { isAddressEqual } from 'viem'

import { OtcActionControl } from './OtcActionControl.container'
import { OtcUsdValue } from './OtcUsdValue.pure'
import * as styledEl from './OtcWrite.styled'
import { reviewedOtcToken, type OtcReviewedToken } from './otcWriteForm'
import { getOtcActionReviewKey } from './otcWriteOrder.utils'
import { useOtcUsdAmount } from './useOtcUsdAmount'

import type { OtcActionDefinition } from './useOtcActionController'
import type { OtcOrder } from 'ophis/otc'
import type { Address } from 'viem'

function buildOrderActionDefinition(
  account: Address | undefined,
  order: OtcOrder,
  isMaker: boolean,
  reviewed: boolean,
  resetKey: string,
  paymentToken: OtcReviewedToken | null,
  receivedToken: OtcReviewedToken | null,
): OtcActionDefinition {
  const reviewedTerms = !!paymentToken && !!receivedToken
  return {
    executeLabel: isMaker ? 'Cancel order' : 'Fill entire order',
    unavailableLabel: order.active ? 'Order terms unavailable' : 'Order is inactive',
    ready: order.active && reviewedTerms,
    reviewed,
    resetKey,
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
  paymentUsdValue,
  paymentUsdLoading,
  receivedUsdValue,
  receivedUsdLoading,
}: {
  isMaker: boolean
  order: OtcOrder
  paymentToken: OtcReviewedToken | null
  receivedToken: OtcReviewedToken | null
  paymentUsdValue: string | null
  paymentUsdLoading: boolean
  receivedUsdValue: string | null
  receivedUsdLoading: boolean
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
      <OtcUsdValue amount={order.amountB} value={paymentUsdValue} isLoading={paymentUsdLoading} />
      <p>
        Receive {formatOtcAmount(order.amountA, receivedToken.decimals)} {receivedToken.symbol}.
      </p>
      <OtcUsdValue amount={order.amountA} value={receivedUsdValue} isLoading={receivedUsdLoading} />
      <p>The fill uses a fresh three-minute deadline and may lose an Ethereum race.</p>
    </styledEl.WriteSummary>
  )
}

export function OtcOrderActionPanel({ order, onConfirmed }: { order: OtcOrder; onConfirmed?: () => void }): ReactNode {
  const { account } = useWalletInfo()
  const [reviewedKey, setReviewedKey] = useState<string | null>(null)
  const isMaker = !!account && isAddressEqual(account, order.maker)
  const paymentToken = reviewedOtcToken(order.tokenB)
  const receivedToken = reviewedOtcToken(order.tokenA)
  const paymentUsd = useOtcUsdAmount(isMaker ? null : paymentToken, isMaker ? null : order.amountB)
  const receivedUsd = useOtcUsdAmount(isMaker ? null : receivedToken, isMaker ? null : order.amountA)
  const resetKey = getOtcActionReviewKey(account, [
    isMaker ? 'cancel' : 'fill',
    order.orderId,
    order.maker,
    order.active,
    order.tokenA,
    order.amountA,
    order.tokenB,
    order.amountB,
  ])
  const reviewed = reviewedKey === resetKey
  const definition = useMemo(
    () => buildOrderActionDefinition(account, order, isMaker, reviewed, resetKey, paymentToken, receivedToken),
    [account, isMaker, order, paymentToken, receivedToken, resetKey, reviewed],
  )

  return (
    <Section
      id="otc-order-action"
      title={
        !order.active ? 'Recover token allowance' : isMaker ? 'Cancel order on local fork' : 'Fill order on local fork'
      }
    >
      <Callout tone="warning" title="Fork-only transaction mode">
        <p>
          {order.active
            ? 'Preflight re-reads these exact terms and simulates the call before your wallet is asked to submit.'
            : 'This order is inactive. Only a positive existing escrow allowance can be revoked.'}
        </p>
      </Callout>
      <OtcOrderTermsSummary
        isMaker={isMaker}
        order={order}
        paymentToken={paymentToken}
        receivedToken={receivedToken}
        paymentUsdValue={paymentUsd.value}
        paymentUsdLoading={paymentUsd.isLoading}
        receivedUsdValue={receivedUsd.value}
        receivedUsdLoading={receivedUsd.isLoading}
      />
      {order.active && (
        <styledEl.ReviewLabel>
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewedKey(event.target.checked ? resetKey : null)}
          />
          {isMaker
            ? 'I reviewed the exact order and understand cancellation costs Ethereum gas.'
            : 'I reviewed both exact token amounts, allowance, escrow risks, and race risk.'}
        </styledEl.ReviewLabel>
      )}
      <OtcActionControl definition={definition} onConfirmed={onConfirmed} />
    </Section>
  )
}
