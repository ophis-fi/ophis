import type { ReactNode } from 'react'

import { formatOtcAmount } from 'ophis/otc'

import { OtcUsdValue } from './OtcUsdValue.pure'
import * as styledEl from './OtcWrite.styled'

import type { OtcReviewedToken } from './otcWriteForm'
import type { OtcOrder } from 'ophis/otc'

export interface OtcOrderTermsSummaryProps {
  isMaker: boolean
  order: OtcOrder
  paymentToken: OtcReviewedToken | null
  receivedToken: OtcReviewedToken | null
  paymentUsdValue: string | null
  paymentUsdLoading: boolean
  receivedUsdValue: string | null
  receivedUsdLoading: boolean
}

export function OtcOrderTermsSummary(props: OtcOrderTermsSummaryProps): ReactNode {
  const {
    isMaker,
    order,
    paymentToken,
    receivedToken,
    paymentUsdValue,
    paymentUsdLoading,
    receivedUsdValue,
    receivedUsdLoading,
  } = props
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
