import { ReactNode, useState } from 'react'

import { CurrencyAmount } from '@cowprotocol/currency'
import { formatEther, formatUnits } from '@ethersproject/units'

import { t } from '@lingui/core/macro'

import { TradeTotalCostsDetails } from 'modules/trade'
import { useUsdAmount } from 'modules/usdAmount'

import { useRateInfoParams } from 'common/hooks/useRateInfoParams'

import { useDirectPriceImpact } from '../../hooks/useDirectPriceImpact'
import { useSwapDerivedState } from '../../hooks/useSwapDerivedState'
import { directGasSymbol, DirectQuote, isMpsSell } from '../../services/wholeToken/router.service'

function displayEth(amount: bigint, roundUp = true): string {
  // Round displayed ceilings up to eight decimals; the transaction uses exact wei.
  return formatEther(((amount + (roundUp ? 9999999999n : 0n)) / 10000000000n) * 10000000000n)
}

export function WholeTokenRouteDetails({
  shown,
  impact,
}: {
  shown: DirectQuote
  impact: ReturnType<typeof useDirectPriceImpact>['impact']
}): ReactNode {
  const { inputCurrency, outputCurrency } = useSwapDerivedState()
  const selling = isMpsSell(shown)
  const gasSymbol = directGasSymbol(shown)
  const totalInput = shown.totalCost - (shown.inputToken ? shown.gasCostInInput || 0n : 0n)
  const unused = shown.budget - totalInput
  const decimals = inputCurrency?.decimals
  const total = inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, totalInput.toString())
  const symbol = inputCurrency?.symbol
  const { value: fiat } = useUsdAmount(total)
  const fees = shown.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const input = inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, shown.sellAmount.toString())
  const output = outputCurrency && CurrencyAmount.fromRawAmount(outputCurrency, shown.buyAmount.toString())
  const feeCurrency = selling ? outputCurrency : inputCurrency
  const feeAmount = feeCurrency && CurrencyAmount.fromRawAmount(feeCurrency, fees.toString())
  const rateInfoParams = useRateInfoParams(input, output)
  const [open, setOpen] = useState(false)
  return (
    <>
      <p>
        <strong>
          {t`Estimated spend`}: {displayInput(totalInput, shown.inputToken, decimals)} {symbol}{' '}
          {fiat && `(≈ $${fiat.toFixed(2)})`}
        </strong>
        <br />
        {feeNotice(shown)}
        <br />
        {t`Estimated unused budget`}: {displayInput(unused, shown.inputToken, decimals, false)} {symbol}
        <br />
        {t`Slippage tolerance`}: {shown.slippageBps / 100}%
      </p>
      <TradeTotalCostsDetails
        rateInfoParams={rateInfoParams}
        totalCosts={feeAmount}
        isFeeDetailsOpen={open}
        toggleAccordion={() => setOpen(!open)}
      >
        <dl>
          <dt>{t`Route`}</dt>
          <dd>{routeLabel(shown)}</dd>
          <dt>{t`Expected input`}</dt>
          <dd>
            {displayInput(shown.sellAmount, shown.inputToken, decimals)} {symbol}
          </dd>
          <dt>{t`Fees`}</dt>
          <dd>
            {formatUnits(fees, feeCurrency?.decimals)} {feeCurrency?.symbol}
          </dd>
          {shown.minBuyAmount !== undefined && (
            <>
              <dt>{t`Minimum received after fees`}</dt>
              <dd>
                {outputCurrency &&
                  `${formatUnits(shown.minBuyAmount, outputCurrency.decimals)} ${outputCurrency.symbol}`}
              </dd>
            </>
          )}
          <dt>{t`Estimated gas`}</dt>
          <dd>
            {displayEth(shown.gasCost)} {gasSymbol}
          </dd>
          <dt>{t`Estimated total`}</dt>
          <dd>
            {displayInput(totalInput, shown.inputToken, decimals)} {symbol} {fiat && `(≈ $${fiat.toFixed(2)})`}
          </dd>
          <dt>{shown.inputToken ? t`Maximum input` : t`Maximum total, including gas`}</dt>
          <dd>
            {displayInput(shown.maxTotal, shown.inputToken, decimals)} {symbol}
          </dd>
          {!!shown.approvalGas && (
            <>
              <dt>{t`Estimated approval gas`}</dt>
              <dd>
                {displayEth(shown.approvalGas * ((shown.maxFeePerGas + shown.maxPriorityFeePerGas) / 2n))} {gasSymbol}
              </dd>
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
        </dl>
        <p>{t`Unused input stays in your wallet or is refunded. Gas is paid separately.`}</p>
      </TradeTotalCostsDetails>
    </>
  )
}

function displayInput(
  amount: bigint,
  inputToken: string | undefined,
  decimals: number | undefined,
  roundUp = true,
): string {
  return inputToken ? formatUnits(amount, decimals) : displayEth(amount, roundUp)
}

function feeNotice(quote: DirectQuote): string {
  if (isMpsSell(quote)) return t`Fees are deducted from the received amount; gas is paid separately.`
  return quote.inputToken ? t`Includes fees; gas is paid separately.` : t`Includes fees and estimated gas.`
}

function routeLabel(quote: DirectQuote): string {
  if (quote.inputToken) return quote.route.label
  if (quote.route.viaV2) return t`Uniswap v3 + v2 via USDC`
  return quote.route.tokens.length > 2 ? t`Uniswap v3 via USDC` : quote.route.label
}
