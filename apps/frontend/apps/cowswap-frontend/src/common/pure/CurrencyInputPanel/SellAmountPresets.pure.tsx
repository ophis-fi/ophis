import type { ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import styled from 'styled-components/macro'

import { CowSwapAnalyticsCategory, toCowSwapGtmEvent } from 'common/analytics/types'

const Presets = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;

  button {
    min-height: 28px;
    padding: 3px 10px;
    border: 1px solid var(--cow-color-border);
    border-radius: 8px;
    background: var(--cow-color-paper);
    color: inherit;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover:enabled,
  button:focus-visible {
    border-color: currentColor;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
`

export function SellAmountPresets({
  spendable,
  onSelect,
}: {
  spendable?: bigint
  onSelect(atoms: bigint): void
}): ReactNode {
  const { t } = useLingui()
  return (
    <Presets role="group" aria-label={t`Percentage of spendable balance`}>
      {[25, 50, 100].map((percent) => {
        const atoms = ((spendable ?? 0n) * BigInt(percent)) / 100n
        return (
          <button
            key={percent}
            type="button"
            disabled={atoms <= 0n}
            data-click-event={toCowSwapGtmEvent({
              category: CowSwapAnalyticsCategory.TRADE,
              action: percent === 100 ? 'Set Maximum Sell Tokens' : `Set ${percent}% Sell Tokens`,
            })}
            onClick={() => onSelect(atoms)}
          >
            {percent === 100 ? <Trans>Max</Trans> : `${percent}%`}
          </button>
        )
      })}
    </Presets>
  )
}
