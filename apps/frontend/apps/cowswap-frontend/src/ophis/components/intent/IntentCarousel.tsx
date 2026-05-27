/**
 * Horizontal auto-scrolling carousel of example swap intents shown below
 * the IntentInput on the landing page. Replaces the older flat ExampleChips
 * row — gives first-time visitors a wider sense of what they can type.
 *
 * UX:
 *   - Continuous left-scrolling marquee via CSS `@keyframes`. Two duplicated
 *     tracks side-by-side make the loop seamless (no visible reset jump).
 *   - Hover or focus anywhere on the strip pauses the animation so the user
 *     can read + click a specific intent.
 *   - Click any chip to pre-fill the IntentInput (same affordance as the
 *     legacy ExampleChips — handler signature unchanged).
 *   - Respects `prefers-reduced-motion: reduce` — paused state by default
 *     for users with motion-sensitivity preferences set.
 *
 * The intent list is curated, NOT live-data. P4 from the backlog originally
 * proposed "anonymized recent swaps"; we shipped curated for v1 because
 * (a) the rebate-indexer's matview is still warming up post-rebrand and
 * (b) showing recency is only valuable once there's enough volume that the
 * list visibly changes between page loads. Swap to a fetch from
 * rebates.ophis.fi when daily Ophis-tagged trade count exceeds ~50.
 */
import { ReactNode } from 'react'

import styled, { keyframes } from 'styled-components/macro'

import { chainLogo, tokenLogo } from './tokenAssets'

type Example = {
  /** Display text shown in the chip + pre-filled into the input on click. */
  readonly label: string
  /** Sell-token symbol for the leading logo (omitted for "buy" examples). */
  readonly from?: string
  /** Buy-token symbol. */
  readonly to: string
  /** Chain slug for the trailing chain logo. */
  readonly chain: string
}

const EXAMPLES: readonly Example[] = [
  { label: 'Swap 100 USDC for ETH on Base', from: 'USDC', to: 'ETH', chain: 'base' },
  { label: 'Trade 0.5 ETH for USDC on Optimism', from: 'ETH', to: 'USDC', chain: 'optimism' },
  { label: 'Buy 1000 USDT on Arbitrum', to: 'USDT', chain: 'arbitrum' },
  { label: 'Swap 250 DAI for WBTC on Ethereum', from: 'DAI', to: 'WBTC', chain: 'ethereum' },
  { label: 'Swap 50 USDC for PEPE on Ethereum', from: 'USDC', to: 'PEPE', chain: 'ethereum' },
  { label: 'Trade 1000 USDT for DOGE on BNB', from: 'USDT', to: 'DOGE', chain: 'bnb' },
  { label: 'Buy 1 ETH on Linea with USDC', from: 'USDC', to: 'ETH', chain: 'linea' },
  { label: 'Swap 500 USDT for ARB on Arbitrum', from: 'USDT', to: 'ARB', chain: 'arbitrum' },
  { label: 'Trade 2 ETH for wstETH on Ethereum', from: 'ETH', to: 'wstETH', chain: 'ethereum' },
  { label: 'Swap 1 ETH for weETH on Arbitrum', from: 'ETH', to: 'weETH', chain: 'arbitrum' },
  { label: 'Trade 5000 USDT for USDC on Polygon', from: 'USDT', to: 'USDC', chain: 'polygon' },
  { label: 'Swap 1000 DAI for sDAI on Ethereum', from: 'DAI', to: 'sDAI', chain: 'ethereum' },
  { label: 'Buy 100 UNI on Ethereum', to: 'UNI', chain: 'ethereum' },
  { label: 'Swap 0.1 ETH for LDO on Ethereum', from: 'ETH', to: 'LDO', chain: 'ethereum' },
  { label: 'Swap 10 ETH for USDC on Base', from: 'ETH', to: 'USDC', chain: 'base' },
  { label: 'Trade 50 USDC for ENA on Ethereum', from: 'USDC', to: 'ENA', chain: 'ethereum' },
]

const scroll = keyframes`
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
`

const Viewport = styled.div`
  width: 100%;
  overflow: hidden;
  /* Soft fade at both edges so chips don't appear/disappear with a hard
     cut, matches the cosmic backdrop's diffuse aesthetic. */
  mask-image: linear-gradient(
    to right,
    transparent 0%,
    #000 8%,
    #000 92%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0%,
    #000 8%,
    #000 92%,
    transparent 100%
  );
`

const Track = styled.div`
  display: flex;
  gap: 8px;
  width: max-content;
  animation: ${scroll} 60s linear infinite;
  will-change: transform;

  &:hover,
  &:focus-within {
    animation-play-state: paused;
  }

  /* On phones, slow the marquee considerably — hover-pause doesn't exist
     for touch and chips become unreadable at desktop speed. 120s lets the
     user follow a specific chip across the screen and tap it. */
  @media (max-width: 600px) {
    animation-duration: 120s;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const Chip = styled.button`
  appearance: none;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(245, 239, 230, 0.18);
  background: rgba(8, 4, 24, 0.45);
  color: rgba(245, 239, 230, 0.78);
  padding: 8px 14px;
  border-radius: 999px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition:
    background 120ms ease-out,
    border-color 120ms ease-out,
    color 120ms ease-out,
    transform 80ms ease-out;

  &:hover {
    background: rgba(242, 166, 62, 0.16);
    border-color: rgba(242, 166, 62, 0.55);
    color: #ffd9a3;
  }

  &:active {
    transform: translateY(1px);
  }

  &:focus-visible {
    outline: 2px solid #f2a63e;
    outline-offset: 2px;
  }

  /* Mobile: chips need a ≥44px tap-target (Apple HIG / Material 48dp) to
     be reliably hittable with a thumb. Larger padding + slightly bigger
     font for readability while the marquee moves. */
  @media (max-width: 600px) {
    padding: 12px 16px;
    font-size: 14px;
  }
`

const Logo = styled.img`
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 auto;
`

// Smaller + dimmed so the chain reads as a suffix, not another token in the pair.
const ChainBadge = styled(Logo)`
  width: 14px;
  height: 14px;
  opacity: 0.9;
`

export function IntentCarousel({ onPick }: { onPick: (text: string) => void }): ReactNode {
  // The track contains the example list twice in immediate succession so
  // that translating by -50% lands on the same starting frame — making
  // the loop seamless. Without the duplication, the user would see the
  // strip snap back to the start every cycle.
  const tracks = [...EXAMPLES, ...EXAMPLES]

  return (
    <Viewport aria-label="Example swap intents">
      <Track>
        {tracks.map((ex, i) => {
          const fromSrc = ex.from ? tokenLogo(ex.from) : undefined
          const toSrc = tokenLogo(ex.to)
          const chainSrc = chainLogo(ex.chain)
          return (
            <Chip
              key={`${ex.label}-${i}`}
              type="button"
              onClick={() => onPick(ex.label)}
              // Mark the duplicate half hidden from screen-readers so the
              // intent list is announced once, not twice.
              aria-hidden={i >= EXAMPLES.length ? true : undefined}
              tabIndex={i >= EXAMPLES.length ? -1 : 0}
            >
              {fromSrc && <Logo src={fromSrc} alt="" aria-hidden="true" />}
              {toSrc && <Logo src={toSrc} alt="" aria-hidden="true" />}
              <span>{ex.label}</span>
              {chainSrc && <ChainBadge src={chainSrc} alt="" aria-hidden="true" />}
            </Chip>
          )
        })}
      </Track>
    </Viewport>
  )
}
