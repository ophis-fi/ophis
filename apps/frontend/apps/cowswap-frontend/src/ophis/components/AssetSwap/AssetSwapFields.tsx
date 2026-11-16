import { ReactNode, useEffect, useRef, useState } from 'react'

import { t } from '@lingui/core/macro'
import { ArrowDown } from 'lucide-react'

import { Field } from 'legacy/state/types'

import { useCloseTokenSelectWidget, useSelectTokenWidgetState } from 'modules/tokensList'
import type { TradeWidgetCurrencyFieldsProps } from 'modules/trade'

import { useAssetSwapCooldown } from './useAssetSwapCooldown'
import { useAssetSwapPickerFocus } from './useAssetSwapPickerFocus'
import { useAssetSwapStyle } from './useAssetSwapStyle'

/** Bencho's slabs applied to Ophis's real amount inputs and token picker.
 * No demo assets, prices or fees enter the trade state. */
export function AssetSwapFields({ input, output, reverse }: TradeWidgetCurrencyFieldsProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const style = useAssetSwapStyle()
  const [turns, setTurns] = useState(0)
  const [coolingDown, startCooldown] = useAssetSwapCooldown()
  const { open, forceOpen, field, onSelectToken } = useSelectTokenWidgetState()
  const close = useCloseTokenSelectWidget()
  // Confirmation replaces the form while the selector itself stays mounted.
  // Release its scroll/quote locks when its inline portal host disappears.
  useEffect(() => () => close({ overrideForceLock: true }), [close])
  const reversed = turns % 2 === 1
  const fields = reversed ? [Field.OUTPUT, Field.INPUT] : [Field.INPUT, Field.OUTPUT]
  const pick = (open || forceOpen) && onSelectToken && field ? fields.indexOf(field) : null
  useAssetSwapPickerFocus(root, pick, () => close({ overrideForceLock: true }))

  return (
    <div
      ref={root}
      className="swp swp-live"
      data-picker-open={pick !== null || undefined}
      style={style}
      aria-label={t`Swap assets`}
      role="group"
    >
      {fields.map((slabField, position) => {
        const on = pick === position
        return (
          <div
            key={position}
            className="swp-live-card"
            data-lifted={on || undefined}
            hidden={pick !== null && !on}
            style={{ gridRow: on ? '1 / 3' : position + 1 }}
            tabIndex={on ? -1 : undefined}
            role={on ? 'dialog' : undefined}
            aria-label={
              on ? (slabField === Field.INPUT ? t`You sell: choose a token` : t`You buy: choose a token`) : undefined
            }
          >
            {/* Keep the amount inputs mounted while the picker owns the slab. */}
            <div
              className="swp-live-face"
              inert={pick !== null}
              aria-hidden={pick !== null || undefined}
              style={{ opacity: on ? 0 : 1 }}
            >
              {slabField === Field.INPUT ? input : output}
            </div>
            <div id={`asset-swap-picker-${slabField}`} className="swp-live-picker" hidden={!on} />
          </div>
        )
      })}
      <button
        type="button"
        className="swp-flip"
        aria-label={t`Reverse swap direction`}
        aria-busy={reverse.loading}
        disabled={reverse.disabled || coolingDown || pick !== null}
        hidden={pick !== null}
        style={{ transform: `rotate(${turns * 180}deg)` }}
        onClick={() => {
          // A destination-only network can reject reversal. Keep its existing
          // direction and slab positions when the trade action declines it.
          if (reverse.onClick() === false) return
          startCooldown()
          setTurns((count) => count + 1)
        }}
      >
        <ArrowDown size={18} strokeWidth={2.2} />
      </button>
    </div>
  )
}
