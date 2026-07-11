/**
 * Pre-trade "beat the market" line for the Ophis swap widget.
 *
 * Drop-in: reads the current quote itself (useGetReceiveAmountInfo) and the
 * reference comparison (useBeatMarket), and renders the savings line, or
 * nothing. Mounted in the trade rate details (quote time) and the swap confirm
 * screen. Renders only when Ophis beats the all-DEX reference (positive saving)
 * on a sell order; otherwise it is invisible.
 *
 * The saving is shown as a concrete dollar amount plus the percentage (e.g.
 * "~$4.82 (0.48%)"), which is more legible than basis points. The dollar figure
 * is the USD value of the extra buy-token Ophis returns over the reference; if no
 * USD price is available it degrades to the percentage alone.
 */
import { ReactNode, useMemo } from 'react'

import { FiatAmount, TokenAmount } from '@cowprotocol/ui'

import { useGetReceiveAmountInfo } from 'modules/trade'
import { useUsdAmount } from 'modules/usdAmount'

import styled from 'styled-components/macro'

import { useBeatMarket } from '../../hooks/useBeatMarket'

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 10px 0;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--cow-color-success-bg, rgba(0, 168, 107, 0.08));
  font-size: 12px;
  line-height: 1.35;
`

const Headline = styled.span`
  font-weight: 600;
  color: var(--cow-color-success-text, var(--cow-color-success, #0b9d58));
`

const Sub = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  opacity: 0.7;
`

export function OphisBeatMarket(): ReactNode {
  const info = useGetReceiveAmountInfo()
  const { status, savingBps, ophisAmount, marketAmount } = useBeatMarket(info)

  // The extra buy-token Ophis returns over the reference, in the buy currency.
  // Computed before any early return so the USD hook is always called (rules of hooks).
  const savedAmount = useMemo(
    () =>
      ophisAmount && marketAmount && ophisAmount.greaterThan(marketAmount)
        ? ophisAmount.subtract(marketAmount)
        : null,
    [ophisAmount, marketAmount],
  )
  const savedUsd = useUsdAmount(savedAmount).value

  // Hide a sub-1-bps edge: integer bps truncates to 0, and a near-zero saving
  // reads as no saving. Only show a number that rounds to at least 1 bp.
  if (status !== 'ok' || savingBps == null || savingBps < 1 || !ophisAmount || !marketAmount) return null

  const percent = `${(savingBps / 100).toFixed(2)}%`

  return (
    <Wrapper>
      <Headline title="Compared against a reference quote from a public market aggregator. For low-liquidity or volatile pairs the reference can be imprecise, so treat this as an estimate, not a guarantee.">
        {/* FiatAmount already prefixes "≈", so no extra "~" in the dollar branch;
            the percent-only fallback adds its own "~". */}
        You save{' '}
        {savedUsd ? (
          <>
            <FiatAmount amount={savedUsd} /> ({percent})
          </>
        ) : (
          <>~{percent}</>
        )}{' '}
        vs. a market reference route
      </Headline>
      <Sub>
        Ophis <TokenAmount amount={ophisAmount} tokenSymbol={ophisAmount.currency} /> · market{' '}
        <TokenAmount amount={marketAmount} tokenSymbol={marketAmount.currency} />
      </Sub>
    </Wrapper>
  )
}
