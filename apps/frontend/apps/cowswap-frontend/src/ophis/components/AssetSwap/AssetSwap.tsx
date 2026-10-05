/* Adapted from Bencho — Copyright (c) 2026 Lorenzo Cabra. MIT; see LICENSE.bencho. */
import { type ReactNode, useRef } from 'react'

import { useReducedMotionPreference } from '@cowprotocol/common-hooks'

import { ArrowDown } from 'lucide-react'
import { useTheme } from 'styled-components/macro'

import { MotionButton } from './AssetSwap.motion'
import { AssetSwapDemoSlab } from './AssetSwapDemoSlab'
import { useAssetSwapDemo } from './useAssetSwapDemo'
import { useAssetSwapPickerFocus } from './useAssetSwapPickerFocus'
import { useAssetSwapStyle } from './useAssetSwapStyle'

/* ══ Asset swap ═══════════════════════════════════════════
   Two rounded slabs, one over the other, each holding a coin and
   an amount, and an arrow on the seam saying which way the swap
   goes. Press the arrow and it turns to point the other way.
   The slabs and the coins in them stay exactly where they are:
   only the direction changes, and the labels with it — whichever
   slab the arrow leaves is "You pay", the one it points at is
   "You receive".

   ── THE ARROW KEEPS TURNING ONE WAY ──────────────────────
   Half a turn every press, counted up rather than flipped
   between 0 and 180, so the second press carries on round
   instead of unwinding back the way it came.

   ── THE SLAB IS THE PICKER ───────────────────────────────
   Press a coin and the slab it sits in grows — the same element,
   its height animated — until it covers the whole block: the top
   slab down over the bottom one, the bottom slab up over the top.
   Its own face fades out and the list of coins loads inside it;
   pick one and it shrinks back to a slab. Nothing is laid over
   it and nothing replaces it. Picking
   the coin already on the other slab swaps the two, which is
   what every exchange does rather than allowing a coin for
   itself. */

const W = 320
const CARD = 116
const GAP = 3
const H = CARD * 2 + GAP

export function AssetSwap({
  /* what is being swapped: crypto or currencies */
  assets = 'Crypto',
  /* how much the arrow overshoots as it turns, 0..100 */
  bounce = 30,
  /* the slabs' corner, px */
  corner = 28,
}: {
  assets?: string
  bounce?: number
  corner?: number
} = {}): ReactNode {
  const { darkMode } = useTheme()
  const root = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotionPreference()
  const themeStyle = useAssetSwapStyle()
  const state = useAssetSwapDemo(assets)
  const { coins, pick, lifted, turns, payer, setPick, setTurns } = state
  const spring = {
    type: 'spring' as const,
    duration: reducedMotion ? 0 : 0.6,
    bounce: (Math.min(100, Math.max(0, bounce)) / 100) * 0.5,
  }
  /* the button's corner follows the slabs', capped at a circle */
  const r = Math.min(Math.max(0, corner), 20)
  /* Escape shuts the picker */
  useAssetSwapPickerFocus(root, pick, () => setPick(null))

  return (
    <div
      ref={root}
      className="swp"
      data-fill={darkMode ? 'dark' : undefined}
      role="group"
      aria-label="Asset swap demo"
      style={{ ...themeStyle, width: W, height: H, ['--swp-r' as string]: `${Math.max(0, corner)}px` }}
    >
      {coins.map((_, i) => (
        <AssetSwapDemoSlab key={i} i={i} state={state} reducedMotion={reducedMotion} />
      ))}
      <MotionButton
        type="button"
        className="swp-flip"
        style={{ borderRadius: r }}
        initial={false}
        /* the arrow leaves as soon as a slab starts to open, and only
           comes back once that slab is home — lifted clears when
           the shrink lands, not when the close is asked for */
        animate={{ rotate: turns * 180, scale: lifted === null ? 1 : 0.5, opacity: lifted === null ? 1 : 0 }}
        transition={
          reducedMotion
            ? { duration: 0 }
            : {
                default: spring,
                scale: lifted === null ? { type: 'spring', duration: 0.4, bounce: 0.35 } : { duration: 0.12 },
                opacity: { duration: lifted === null ? 0.18 : 0.1 },
              }
        }
        whileTap={reducedMotion ? undefined : { scale: 0.9 }}
        onClick={() => {
          setTurns((n) => n + 1)
        }}
        tabIndex={pick === null ? 0 : -1}
        disabled={lifted !== null}
        aria-label={`Paying ${coins[payer]} for ${coins[1 - payer]}. Reverse`}
      >
        <ArrowDown size={18} strokeWidth={2.2} />
      </MotionButton>
    </div>
  )
}
