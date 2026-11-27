import type { ReactNode } from 'react'

import * as styledEl from './styled'

export function SwapAmountPair({ sell, buy }: { sell: ReactNode; buy: ReactNode }): ReactNode {
  return (
    <styledEl.AmountsPreviewContainer>
      {sell}
      <styledEl.SeparatorWrapper aria-hidden="true">
        <styledEl.AmountsSeparator />
      </styledEl.SeparatorWrapper>
      {buy}
    </styledEl.AmountsPreviewContainer>
  )
}
