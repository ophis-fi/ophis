/**
 * Three preset prompts shown below the IntentInput on the landing page.
 *
 * Click pre-fills the input. They teach the affordance for first-timers
 * who otherwise wouldn't know what to type into a "natural-language"
 * swap field.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

const EXAMPLES = [
  'Swap 100 USDC for ETH on Base',
  'Trade ETH for USDC on Optimism',
  'Buy 1000 USDT on Arbitrum',
]

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  padding-top: 4px;
`

const Chip = styled.button`
  appearance: none;
  border: 1px solid rgba(245, 239, 230, 0.18);
  background: rgba(8, 4, 24, 0.45);
  color: rgba(245, 239, 230, 0.78);
  padding: 8px 14px;
  border-radius: 999px;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, transform 80ms ease-out;

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
`

export function ExampleChips({ onPick }: { onPick: (text: string) => void }): ReactNode {
  return (
    <Row>
      {EXAMPLES.map((ex) => (
        <Chip key={ex} type="button" onClick={() => onPick(ex)}>
          {ex}
        </Chip>
      ))}
    </Row>
  )
}
