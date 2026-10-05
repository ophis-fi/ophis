/* Adapted from Bencho — Copyright (c) 2026 Lorenzo Cabra. MIT; see LICENSE.bencho. */
import { ReactNode } from 'react'

import { Check, X } from 'lucide-react'

import { BY, Coin } from './AssetSwap.demo.const'
import { AnimatePresence, MotionDiv } from './AssetSwap.motion'
import { AssetSwapDemoState } from './useAssetSwapDemo'

const CARD = 116
const PITCH = CARD + 3
const H = CARD * 2 + 3
interface SlabProps {
  state: AssetSwapDemoState
  i: number
  reducedMotion: boolean
}

function Logo({ coin, size }: { coin: Coin; size: number }): ReactNode {
  return (
    <svg className="swp-logo" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      {coin.logo}
    </svg>
  )
}

export function AssetSwapDemoSlab({ state, i, reducedMotion }: SlabProps): ReactNode {
  const { coins, pick, lifted, payer, shown, open, setLifted } = state
  /* the slab's growth: firm, with only a breath of overshoot */
  const grow = { type: 'spring' as const, duration: reducedMotion ? 0 : 0.5, bounce: 0.12 }
  const coin = BY[coins[i]]
  const on = pick === i
  /* the OTHER slab, while this one's neighbour is open */
  const squeezed = pick !== null && !on
  /* the slab's role, which the picker keeps as its heading — it
           is the same slab, still saying what it is for */
  const role = i === payer ? 'You pay' : 'You receive'
  const dialogProps = on ? { role: 'dialog' as const, tabIndex: -1, 'aria-label': `${role}: choose a coin` } : {}
  return (
    <MotionDiv
      className="swp-card"
      data-lifted={lifted === i || undefined}
      initial={false}
      /* THE SLAB IS THE PICKER: the same element, its height
               grown to the whole block — down from the top slab, up
               from the bottom one */
      animate={{
        top: on ? 0 : i * PITCH,
        height: on ? H : CARD,
        /* the neighbour is SQUEEZED: pressed toward its far edge
                 by the slab growing into it. Flattened on the same
                 curve that grows the open slab, so its near edge stays
                 just ahead of the growing one instead of being run
                 over — it visibly gives, then fades out before it is
                 flat */
        scaleY: squeezed ? 0.02 : 1,
        opacity: squeezed ? 0 : 1,
      }}
      style={{ transformOrigin: i === 0 ? '50% 0%' : '50% 100%' }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              default: grow,
              /* no overshoot here: past flat a scale turns inside out */
              scaleY: { type: 'spring', duration: 0.5, bounce: 0 },
              opacity: squeezed ? { delay: 0.1, duration: 0.14 } : { delay: 0.06, duration: 0.2 },
            }
      }
      /* lowered only when a SHRINK lands: the open finishing can
               report in after a close has already started */
      onAnimationComplete={(d) => {
        if ((d as { height?: number }).height === CARD && pick === null) setLifted((l) => (l === i ? null : l))
      }}
      {...dialogProps}
    >
      {/* what the slab shows: pinned to the edge the slab grows
                away from, so it never moves; it fades as the list
                arrives and comes back as the slab shuts */}
      <MotionDiv
        className="swp-face"
        style={i === 0 ? { top: 0 } : { bottom: 0 }}
        initial={false}
        animate={{ opacity: on ? 0 : 1 }}
        transition={reducedMotion ? { duration: 0 } : on ? { duration: 0.12 } : { delay: 0.14, duration: 0.2 }}
        aria-hidden={pick !== null || undefined}
        inert={pick !== null}
      >
        <span className="swp-label">{role}</span>
        <span className="swp-amount">{shown(i).amount}</span>
        <span className="swp-fiat">{shown(i).fiat}</span>
        <button
          type="button"
          className="swp-coin"
          onClick={() => open(i)}
          tabIndex={pick === null ? 0 : -1}
          aria-label={`${coin.name}. Choose another coin`}
          aria-haspopup="dialog"
          aria-expanded={on}
        >
          <Logo coin={coin} size={22} />
          {coin.sym}
        </button>
      </MotionDiv>
      <AssetSwapDemoPicker state={state} i={i} role={role} reducedMotion={reducedMotion} />
    </MotionDiv>
  )
}
function AssetSwapDemoPicker({ state, i, role, reducedMotion }: SlabProps & { role: string }): ReactNode {
  const on = state.pick === i
  return (
    <>
      {/* the list loads inside once the slab is mostly open,
                and goes before it starts to shut */}
      <AnimatePresence>
        {on && (
          <MotionDiv
            className="swp-pick-in"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: reducedMotion ? { duration: 0 } : { delay: 0.1, duration: 0.22 } }}
            exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : 0.1 } }}
          >
            <div className="swp-pick-head">
              <span>{role}</span>
              <button type="button" className="swp-pick-x" onClick={() => state.setPick(null)} aria-label="Close">
                <X size={16} strokeWidth={2.2} />
              </button>
            </div>
            {state.set.list.map((c) => (
              <button key={c.sym} type="button" className="swp-pick-row" onClick={() => state.choose(c.sym)}>
                <Logo coin={c} size={24} />
                <span className="swp-pick-sym">{c.sym}</span>
                <span className="swp-pick-name">{c.name}</span>
                {state.coins[i] === c.sym && <Check className="swp-pick-on" size={16} strokeWidth={2.4} />}
              </button>
            ))}
          </MotionDiv>
        )}
      </AnimatePresence>
    </>
  )
}
