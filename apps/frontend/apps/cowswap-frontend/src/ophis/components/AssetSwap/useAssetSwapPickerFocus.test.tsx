import { ReactNode, useRef, useState } from 'react'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'

import { useAssetSwapPickerFocus } from './useAssetSwapPickerFocus'

function PickerHarness(): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [networkOpen, setNetworkOpen] = useState(false)
  useAssetSwapPickerFocus(root, pick, () => setPick(null))
  return (
    <div data-mobile-swap-form>
      <button data-token-picker-trigger onClick={() => setNetworkOpen(true)}>
        Source network
      </button>
      {networkOpen &&
        createPortal(
          <button
            onClick={() => {
              setNetworkOpen(false)
              setPick(0)
            }}
          >
            Non-EVM network
          </button>,
          document.body,
        )}
      <div ref={root}>
        <button className="open-currency-select-button" onClick={() => setPick(0)}>
          Pay asset
        </button>
        <button className="open-currency-select-button" onClick={() => setPick(1)}>
          Receive asset
        </button>
        {pick !== null && (
          <div role="dialog" tabIndex={-1}>
            Choose asset
          </div>
        )}
      </div>
      <button onClick={() => setPick(0)}>Programmatic open</button>
    </div>
  )
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

function nextFrame(): void {
  act(() => jest.advanceTimersByTime(20))
}

function openFrom(name: string): HTMLElement {
  const trigger = screen.getByRole('button', { name })
  act(() => trigger.focus())
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  if (name === 'Source network') fireEvent.click(screen.getByRole('button', { name: 'Non-EVM network' }))
  nextFrame()
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
  return trigger
}

it.each(['Source network', 'Pay asset', 'Receive asset'])('restores focus to %s after Escape', (name) => {
  render(<PickerHarness />)
  // A preceding slab interaction must not steal the header's restoration.
  const previous = openFrom('Pay asset')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  expect(document.activeElement).toBe(previous)

  const trigger = openFrom(name)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  expect(document.activeElement).toBe(trigger)
})

it('clears the previous opener after restoring focus', () => {
  render(<PickerHarness />)
  const trigger = openFrom('Source network')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  const focus = jest.spyOn(trigger, 'focus')
  fireEvent.click(screen.getByRole('button', { name: 'Programmatic open' }))
  nextFrame()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  expect(focus).not.toHaveBeenCalled()
  focus.mockRestore()
})

it('remembers a keyboard reactivation without a new focus or pointer event', () => {
  render(<PickerHarness />)
  const trigger = openFrom('Pay asset')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  nextFrame()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  nextFrame()
  expect(document.activeElement).toBe(trigger)
})
