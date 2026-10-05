import { ReactNode, useEffect, useRef, useState } from 'react'

import { useReducedMotionPreference } from '@cowprotocol/common-hooks'

import { t } from '@lingui/core/macro'
import { ArrowDown } from 'lucide-react'

import { Field } from 'legacy/state/types'

import { useCloseTokenSelectWidget, useSelectTokenWidgetState } from 'modules/tokensList'
import type { TradeWidgetCurrencyFieldsProps } from 'modules/trade'

import { MotionDiv, MotionButton } from './AssetSwap.motion'
import { useAssetSwapCooldown } from './useAssetSwapCooldown'
import { useAssetSwapPickerFocus } from './useAssetSwapPickerFocus'
import { useAssetSwapStyle } from './useAssetSwapStyle'

/** Bencho's slabs applied to Ophis's real amount inputs and token picker.
 * No demo assets, prices or fees enter the trade state. */
export function AssetSwapFields({ input, output, reverse }: TradeWidgetCurrencyFieldsProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const style = useAssetSwapStyle()
  const reducedMotion = useReducedMotionPreference()
  const [turns, setTurns] = useState(0)
  const [turning, setTurning] = useState(false)
  const [coolingDown, startCooldown] = useAssetSwapCooldown()
  const [lifted, setLifted] = useState<number | null>(null)
  const { open, forceOpen, field, onSelectToken } = useSelectTokenWidgetState()
  const close = useCloseTokenSelectWidget()
  // Confirmation replaces the form while the selector itself stays mounted.
  // Release its scroll/quote locks when its inline portal host disappears.
  useEffect(() => () => close({ overrideForceLock: true }), [close])
  const reversed = turns % 2 === 1
  const fields = reversed ? [Field.OUTPUT, Field.INPUT] : [Field.INPUT, Field.OUTPUT]
  const pick = (open || forceOpen) && onSelectToken && field ? fields.indexOf(field) : null
  useEffect(() => {
    if (pick !== null || reducedMotion) setLifted(pick)
  }, [pick, reducedMotion])
  const grow = { type: 'spring' as const, duration: reducedMotion ? 0 : 0.5, bounce: 0.12 }
  const returnDelay = !reducedMotion && pick === null && lifted !== null ? grow.duration : 0
  const returnTransition = { delay: returnDelay, duration: reducedMotion ? 0 : 0.18 }
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
        const squeezed = pick !== null && !on
        return (
          <MotionDiv
            key={position}
            layout
            className="swp-live-card"
            data-lifted={on || lifted === position || undefined}
            style={{ gridRow: on ? '1 / 3' : position + 1, transformOrigin: position === 0 ? '50% 0%' : '50% 100%' }}
            initial={false}
            animate={{ scaleY: squeezed ? 0.02 : 1, opacity: squeezed ? 0 : 1 }}
            transition={{
              layout: grow,
              scaleY: { ...grow, bounce: 0 },
              opacity: { duration: reducedMotion ? 0 : 0.14 },
            }}
            tabIndex={on ? -1 : undefined}
            role={on ? 'dialog' : undefined}
            aria-label={
              on ? (slabField === Field.INPUT ? t`You pay: choose a token` : t`You receive: choose a token`) : undefined
            }
          >
            {/* The face stays in its slab; the existing picker mounts inside that
                same element. The neighbouring slab gives way as it grows. */}
            <div
              className="swp-live-face"
              inert={pick !== null}
              aria-hidden={pick !== null || undefined}
              style={{ opacity: on ? 0 : 1 }}
            >
              {slabField === Field.INPUT ? input : output}
            </div>
            <div id={`asset-swap-picker-${slabField}`} className="swp-live-picker" hidden={!on} />
          </MotionDiv>
        )
      })}
      <MotionButton
        type="button"
        className="swp-flip"
        aria-label={t`Reverse swap direction`}
        aria-busy={reverse.loading}
        disabled={reverse.disabled || turning || coolingDown || pick !== null || lifted !== null}
        initial={false}
        // Count turns upward: every press carries on round, never unwinds.
        animate={{
          rotate: turns * 180,
          opacity: pick === null ? 1 : 0,
          scale: pick === null ? 1 : 0.5,
        }}
        transition={{
          default: { type: 'spring', duration: reducedMotion ? 0 : 0.6, bounce: 0.15 },
          opacity: returnTransition,
          scale: returnTransition,
        }}
        onAnimationComplete={() => {
          setTurning(false)
          // Keep the shrinking slab above its neighbour until the delayed
          // arrow returns; layout callbacks can be skipped for the lower row.
          if (pick === null) setLifted(null)
        }}
        onClick={() => {
          // A destination-only network can reject reversal. Keep its existing
          // direction and slab positions when the trade action declines it.
          if (reverse.onClick() === false) return
          startCooldown()
          if (!reducedMotion) setTurning(true)
          setTurns((count) => count + 1)
        }}
      >
        <ArrowDown size={18} strokeWidth={2.2} />
      </MotionButton>
    </div>
  )
}
