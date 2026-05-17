import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { Media, TokenAmount, UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

import { safeToExact } from 'common/utils/safeCurrencyAmount'

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
  // Defensive: a CurrencyAmount hydrated from a stale persisted atom can
  // have `.currency` undefined despite the static type. `safeToExact` covers
  // the `.toExact()` throw path (reads `.currency.decimals` internally);
  // the symbol fallback handles the `.symbol` access. Together they keep
  // the orders table render alive even with one corrupted row.
  const title = `${safeToExact(amount)} ${amount?.currency?.symbol ?? ''}`.trim()
  return (
    <AmountItem title={title}>
      <TokenAmount amount={amount} tokenSymbol={amount?.currency} />
    </AmountItem>
  )
}
