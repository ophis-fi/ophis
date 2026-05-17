import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { Media, TokenAmount, UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

const AmountItem = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  ${Media.upToSmall()} {
    white-space: normal;
  }

  > div {
    display: flex;
    align-items: center;
  }

  > span {
    white-space: normal;
    word-break: break-all;
    max-width: 150px;
    display: inline;
  }

  > span > span {
    color: var(${UI.COLOR_TEXT_OPACITY_70});
  }
`

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function CurrencyAmountItem({ amount }: { amount: CurrencyAmount<Currency> }) {
  // Defensive (2026-05-17 incident): a CurrencyAmount hydrated from a stale
  // persisted atom can have `.currency` undefined despite the static type.
  // The title is a hover-tooltip — degrade to a blank when the currency is
  // missing rather than crashing the entire orders table.
  const title = `${amount?.toExact() ?? ''} ${amount?.currency?.symbol ?? ''}`.trim()
  return (
    <AmountItem title={title}>
      <TokenAmount amount={amount} tokenSymbol={amount?.currency} />
    </AmountItem>
  )
}
