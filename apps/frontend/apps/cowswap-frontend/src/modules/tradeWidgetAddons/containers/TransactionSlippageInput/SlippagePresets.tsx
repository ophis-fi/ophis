import { JSX } from 'react'

import * as styledEl from './TransactionSlippageInput.styled'

/** Preset slippage tiers in bps (ux-quoting decision 61): 0.1% / 0.5% / 1.0%. */
export const SLIPPAGE_PRESET_BPS: readonly number[] = [10, 50, 100]

export interface SlippagePresetsProps {
  /** Bps value currently applied by an explicit user choice, or null when Auto/default. */
  activeBps: number | null
  /** Valid slippage range in bps from the slippage config (eth-flow raises the minimum). */
  minBps: number
  maxBps: number
  onSelect(bps: number): void
}

function formatPresetLabel(bps: number): string {
  const percent = bps / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
}

/**
 * Preset buttons beside Auto. Selection funnels through the exact same input
 * path as typed values (validation, eth-flow minimums, warnings, per-chain
 * persistence), so a preset behaves identically to typing the number. Presets
 * outside the currently valid range (e.g. below the eth-flow minimum) are
 * disabled instead of producing an instant error.
 */
export function SlippagePresets({ activeBps, minBps, maxBps, onSelect }: SlippagePresetsProps): JSX.Element {
  return (
    <>
      {SLIPPAGE_PRESET_BPS.map((presetBps) => (
        <styledEl.PresetButton
          key={presetBps}
          type="button"
          data-bps={presetBps}
          data-testid={`slippage-preset-${presetBps}`}
          active={activeBps === presetBps}
          disabled={presetBps < minBps || presetBps > maxBps}
          onClick={() => onSelect(presetBps)}
        >
          {formatPresetLabel(presetBps)}
        </styledEl.PresetButton>
      ))}
    </>
  )
}
