import { fireEvent, render, screen } from '@testing-library/react'

import { SLIPPAGE_PRESET_BPS, SlippagePresets } from './SlippagePresets'

function getPreset(label: string): HTMLButtonElement {
  return screen.getByText(label) as HTMLButtonElement
}

describe('SlippagePresets', () => {
  const defaultProps = {
    activeBps: null,
    minBps: 1,
    maxBps: 5000,
    onSelect: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders the three preset tiers 0.1% / 0.5% / 1%', () => {
    render(<SlippagePresets {...defaultProps} />)

    expect(SLIPPAGE_PRESET_BPS).toEqual([10, 50, 100])
    expect(getPreset('0.1%')).toBeTruthy()
    expect(getPreset('0.5%')).toBeTruthy()
    expect(getPreset('1%')).toBeTruthy()
  })

  it('reports the clicked preset in bps', () => {
    const onSelect = jest.fn()
    render(<SlippagePresets {...defaultProps} onSelect={onSelect} />)

    fireEvent.click(getPreset('0.5%'))

    expect(onSelect).toHaveBeenCalledWith(50)
  })

  it('marks only the active preset', () => {
    render(<SlippagePresets {...defaultProps} activeBps={50} />)

    expect(getPreset('0.5%').getAttribute('data-bps')).toBe('50')
    expect(getPreset('0.1%').getAttribute('data-bps')).toBe('10')
  })

  it('disables presets outside the valid range (eth-flow minimum)', () => {
    // Eth-flow raises the minimum to 200 bps: every preset is below it.
    render(<SlippagePresets {...defaultProps} minBps={200} />)

    expect(getPreset('0.1%').disabled).toBe(true)
    expect(getPreset('0.5%').disabled).toBe(true)
    expect(getPreset('1%').disabled).toBe(true)
  })

  it('keeps presets inside the range enabled', () => {
    render(<SlippagePresets {...defaultProps} minBps={50} maxBps={5000} />)

    expect(getPreset('0.1%').disabled).toBe(true)
    expect(getPreset('0.5%').disabled).toBe(false)
    expect(getPreset('1%').disabled).toBe(false)
  })
})
