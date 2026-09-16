import { ReactNode } from 'react'

import { CurrencyAmount } from '@cowprotocol/currency'

import { t } from '@lingui/core/macro'

import { RwaConsentModalContainer, useRwaConsentModalState } from 'modules/rwa'
import { ConfirmAmounts } from 'modules/trade'
import { useUsdAmount } from 'modules/usdAmount'

import { NewModal } from 'common/pure/NewModal'

import { WholeTokenRoute, WholeTokenRouteProps } from './WholeTokenRoute.container'

import { useDirectPriceImpact } from '../../hooks/useDirectPriceImpact'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'

export function WholeTokenReview(props: WholeTokenRouteProps): ReactNode {
  const { inputCurrency, outputCurrency, inputCurrencyBalance, outputCurrencyBalance } = useSwapDerivedState()
  const { quote, review } = props
  const input =
    inputCurrency &&
    CurrencyAmount.fromRawAmount(
      inputCurrency,
      (quote.sellAmount + quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)).toString(),
    )
  const output = outputCurrency && CurrencyAmount.fromRawAmount(outputCurrency, quote.buyAmount.toString())
  const { value: inputFiat } = useUsdAmount(input)
  const { value: outputFiat } = useUsdAmount(output)
  const { impact, loading } = useDirectPriceImpact(quote)
  const { isModalOpen } = useRwaConsentModalState()
  if (isModalOpen) return <RwaConsentModalContainer />
  return (
    <NewModal title={t`Review swap`} onDismiss={() => review(null)}>
      <ConfirmAmounts
        inputCurrencyInfo={{
          amount: input,
          fiatAmount: inputFiat,
          balance: inputCurrencyBalance,
          label: t`Expected spend (incl. fees)`,
        }}
        outputCurrencyInfo={{
          amount: output,
          fiatAmount: outputFiat,
          balance: outputCurrencyBalance,
          label: t`You receive`,
        }}
        priceImpact={{ priceImpact: impact, loading }}
      />
      <p>
        {t`Recipient`}: <span style={{ overflowWrap: 'anywhere' }}>{quote.recipient}</span>
      </p>
      <WholeTokenRoute {...props} />
    </NewModal>
  )
}
