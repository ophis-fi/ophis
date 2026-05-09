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
  border: 1px solid var(--greg-color-stroke-subtle, rgba(110, 115, 117, 0.28));
  background: var(--greg-color-surface-subtle, rgba(255, 243, 238, 0.55));
  color: var(--greg-color-text-secondary, #53575a);
  padding: 8px 14px;
  border-radius: 999px;
  font-family: var(--cow-font-family-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  transition: background 120ms ease-out, border-color 120ms ease-out, transform 80ms ease-out;

  &:hover {
    background: rgba(255, 222, 211, 0.7);
    border-color: #e66a55;
    color: #993627;
  }

  &:active {
    transform: translateY(1px);
  }

  &:focus-visible {
    outline: 2px solid #e66a55;
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
