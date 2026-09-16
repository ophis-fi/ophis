import { useAtomValue } from 'jotai'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { CurrencyAmount, Percent } from '@cowprotocol/currency'
import { useIsTradeUnsupported } from '@cowprotocol/tokens'

import { t } from '@lingui/core/macro'

import { RwaTokenStatus, useRwaTokenStatus, useRwaConsentModalState } from 'modules/rwa'
import { tradeFormValidationContextAtom, TradeFormValidation, validateTradeForm } from 'modules/tradeFormValidation'
import { useUsdAmount } from 'modules/usdAmount'

import { useConfirmationRequest } from 'common/hooks/useConfirmationRequest'
import { useConfirmPriceImpactWithoutFee } from 'common/hooks/useConfirmPriceImpactWithoutFee'

import { useSwapDerivedState } from './useSwapDerivedState'

import { DirectQuote } from '../services/wholeToken/router.service'

export function useDirectPriceImpact(quote: DirectQuote): {
  impact: Percent | undefined
  loading: boolean
  allowed: boolean
  validation: TradeFormValidation | null
  confirm: () => Promise<boolean>
} {
  const { inputCurrency, outputCurrency } = useSwapDerivedState()
  const netInput = getNetInput(quote)
  const input = useUsdAmount(inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, netInput.toString()))
  const output = useUsdAmount(
    outputCurrency && CurrencyAmount.fromRawAmount(outputCurrency, quote.buyAmount.toString()),
  )
  const impact =
    input.value?.greaterThan(0) && output.value
      ? new Percent(input.value.subtract(output.value).quotient, input.value.quotient)
      : undefined
  const context = useAtomValue(tradeFormValidationContextAtom)
  const isSwapUnsupported = useIsTradeUnsupported(inputCurrency, outputCurrency)
  const loading = [input, output].some((price) => !price.value && price.isLoading)
  const validations =
    context &&
    validateTradeForm({
      ...context,
      isSwapUnsupported,
      tradePriceImpact: { ...context.tradePriceImpact, priceImpact: impact, loading },
    })
  // Direct execution validates its own quote, actual balance and expiry.
  const validation =
    validations?.find(
      (validation) =>
        ![
          TradeFormValidation.SellNativeToken,
          TradeFormValidation.ApproveRequired,
          TradeFormValidation.ApproveAndSwapInBundle,
          // Direct swaps send ordinary transactions and never use wallet bundling.
          TradeFormValidation.WalletCapabilitiesLoading,
          TradeFormValidation.QuoteErrors,
          TradeFormValidation.QuoteLoading,
          TradeFormValidation.QuoteExpired,
          TradeFormValidation.BalanceInsufficient,
        ].includes(validation),
    ) ?? null
  const allowed = !!context && validation === null
  const { confirmPriceImpactWithoutFee } = useConfirmPriceImpactWithoutFee(false)
  const confirmUnknown = useConfirmationRequest({})
  const { status, rwaTokenInfo } = useRwaTokenStatus({ inputCurrency, outputCurrency })
  const { openModal } = useRwaConsentModalState()
  return {
    impact,
    loading,
    allowed,
    validation,
    confirm: async () => {
      if (status === RwaTokenStatus.RequiredConsent && rwaTokenInfo) {
        openModal({
          token: TokenWithLogo.fromToken(rwaTokenInfo.token),
          consentHash: rwaTokenInfo.consentHash,
          onImportSuccess: () => {},
        })
        return false
      }
      if (!impact)
        return confirmUnknown({
          title: t`Price impact unavailable`,
          description: t`Price impact is unavailable. You may receive less value than expected.`,
          action: t`continue with this swap`,
          callToAction: t`Confirm Swap`,
          confirmWord: t`confirm`,
          skipInput: true,
        })
      return confirmPriceImpactWithoutFee(impact)
    },
  }
}

function getNetInput(quote: DirectQuote): bigint {
  return quote.netCost - (quote.gasCostInInput ?? quote.gasCost) - quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
}
