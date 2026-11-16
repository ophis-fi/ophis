import { Suspense } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Field } from 'legacy/state/types'

import { AssetSwapFields } from './AssetSwapFields'

const mockClosePicker = jest.fn()
const mockPicker = { open: false, forceOpen: false, field: Field.INPUT, onSelectToken: jest.fn() }
jest.mock('modules/tokensList', () => ({
  useSelectTokenWidgetState: () => mockPicker,
  useCloseTokenSelectWidget: () => mockClosePicker,
}))
jest.mock('./useAssetSwapStyle', () => ({ useAssetSwapStyle: () => ({}) }))

it.each([false, true, undefined])('changes direction only when reversal is accepted (%s)', async (accepted) => {
  const reverse = jest.fn(() => accepted)
  const { container, unmount } = render(
    <Suspense fallback={<span>Loading</span>}>
      <AssetSwapFields
        input={<span>Pay panel</span>}
        output={<span>Receive panel</span>}
        reverse={{ onClick: reverse, disabled: false, loading: false }}
      />
    </Suspense>,
  )
  const arrow = await screen.findByRole('button', { name: 'Reverse swap direction' })
  fireEvent.click(arrow)
  expect(reverse).toHaveBeenCalledTimes(1)
  await waitFor(() => {
    const faces = Array.from(container.querySelectorAll('.swp-live-face')).map((element) => element.textContent)
    expect(faces).toEqual(accepted === false ? ['Pay panel', 'Receive panel'] : ['Receive panel', 'Pay panel'])
  })
  unmount()
  expect(mockClosePicker).toHaveBeenCalledWith({ overrideForceLock: true })
})

it('retains the 500ms reversal cooldown with reduced motion', async () => {
  const reverse = jest.fn(() => true)
  const { unmount } = render(
    <Suspense fallback={<span>Loading</span>}>
      <AssetSwapFields
        input={<span>Pay panel</span>}
        output={<span>Receive panel</span>}
        reverse={{ onClick: reverse, disabled: false, loading: false }}
      />
    </Suspense>,
  )
  const arrow = await screen.findByRole('button', { name: 'Reverse swap direction' })
  jest.useFakeTimers()
  try {
    fireEvent.click(arrow)
    fireEvent.click(arrow)
    expect(reverse).toHaveBeenCalledTimes(1)
    act(() => jest.advanceTimersByTime(499))
    expect(arrow.hasAttribute('disabled')).toBe(true)
    act(() => jest.advanceTimersByTime(1))
    expect(arrow.hasAttribute('disabled')).toBe(false)
    fireEvent.click(arrow)
    expect(reverse).toHaveBeenCalledTimes(2)
  } finally {
    unmount()
    jest.useRealTimers()
  }
})

it('preserves edited amounts while opening and closing either picker', () => {
  const props = {
    input: <input aria-label="Sell amount" defaultValue="12.5" />,
    output: <input aria-label="Buy amount" defaultValue="7" />,
    reverse: { onClick: jest.fn(), disabled: false, loading: false },
  }
  const { rerender, container } = render(<AssetSwapFields {...props} />)
  const amount = screen.getByRole('textbox', { name: 'Sell amount' })
  fireEvent.change(amount, { target: { value: '25' } })

  for (const field of [Field.INPUT, Field.OUTPUT]) {
    mockPicker.open = true
    mockPicker.field = field
    rerender(<AssetSwapFields {...props} />)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(container.querySelector('.swp-flip')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelectorAll('.swp-live-card[hidden]')).toHaveLength(1)
    mockPicker.open = false
    rerender(<AssetSwapFields {...props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Sell amount' })).toBe(amount)
    expect(screen.getByDisplayValue('25')).toBe(amount)
    expect(screen.getByRole('button', { name: 'Reverse swap direction' }).hasAttribute('disabled')).toBe(false)
  }
})
