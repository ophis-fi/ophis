import { act, render, screen } from '@testing-library/react'

import { OtcActionControl } from './OtcActionControl.container'
import { useOtcActionController, type OtcActionDefinition } from './useOtcActionController'

jest.mock('./useOtcActionController', () => ({
  useOtcActionController: jest.fn(),
}))

const useControllerMock = useOtcActionController as jest.MockedFunction<typeof useOtcActionController>

const DEFINITION: OtcActionDefinition = {
  executeLabel: 'Fill entire order',
  ready: true,
  reviewed: true,
  resetKey: 'order-7',
  executeIntent: null,
  requiredAllowance: null,
}

function announcementFor(text: string): HTMLElement {
  const content = screen.getByText(text)
  const announcement = content.closest('[role]')
  if (!(announcement instanceof HTMLElement)) throw new Error(`Missing announcement region for ${text}`)
  return announcement
}

describe('OtcActionControl screen-reader semantics', () => {
  it('announces failed execution and leftover-allowance recovery assertively', () => {
    useControllerMock.mockReturnValue({
      model: { action: 'revoke', label: 'Revoke unused allowance', disabled: false, pending: false },
      error: 'The order changed before submission.',
      successHash: null,
      uncertainHash: null,
      allowance: 2_000_000_000n,
      diagnostic: null,
      clearUncertainTransaction: jest.fn(),
      runPrimary: jest.fn(),
    })

    render(<OtcActionControl definition={DEFINITION} onConfirmed={undefined} />)

    expect((screen.getByRole('button', { name: 'Revoke unused allowance' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(announcementFor('Token allowance must be cleared').getAttribute('aria-live')).toBe('assertive')
    expect(announcementFor('Transaction not completed').getAttribute('aria-atomic')).toBe('true')
  })

  it('announces a confirmed fill politely and keeps repeat submission disabled', () => {
    useControllerMock.mockReturnValue({
      model: { action: 'unavailable', label: 'Transaction confirmed', disabled: true, pending: false },
      error: null,
      successHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      uncertainHash: null,
      allowance: null,
      diagnostic: null,
      clearUncertainTransaction: jest.fn(),
      runPrimary: jest.fn(),
    })

    render(<OtcActionControl definition={DEFINITION} onConfirmed={undefined} />)

    expect((screen.getByRole('button', { name: 'Transaction confirmed' }) as HTMLButtonElement).disabled).toBe(true)
    const confirmation = screen.getByRole('status')
    expect(confirmation.getAttribute('role')).toBe('status')
    expect(confirmation.getAttribute('aria-live')).toBe('polite')
    expect(confirmation.getAttribute('aria-atomic')).toBe('true')
  })

  it('marks cancellation progress as busy without dropping its accessible name', () => {
    useControllerMock.mockReturnValue({
      model: { action: 'unavailable', label: 'Cancelling order...', disabled: true, pending: true },
      error: null,
      successHash: null,
      uncertainHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      allowance: null,
      diagnostic: null,
      clearUncertainTransaction: jest.fn(),
      runPrimary: jest.fn(),
    })

    render(<OtcActionControl definition={DEFINITION} onConfirmed={undefined} />)

    const button = screen.getByRole('button', { name: 'Cancelling order...' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Confirmation unavailable')).toBeNull()
  })

  it('announces an uncertain submitted hash and keeps retry disabled', () => {
    const hash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const clearUncertainTransaction = jest.fn()
    useControllerMock.mockReturnValue({
      model: { action: 'unavailable', label: 'Verify submitted transaction', disabled: true, pending: false },
      error: null,
      successHash: null,
      uncertainHash: hash,
      allowance: 2_000_000_000n,
      diagnostic: null,
      clearUncertainTransaction,
      runPrimary: jest.fn(),
    })

    render(<OtcActionControl definition={DEFINITION} onConfirmed={undefined} />)

    expect((screen.getByRole('button', { name: 'Verify submitted transaction' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(announcementFor('Confirmation unavailable').getAttribute('aria-live')).toBe('assertive')
    expect(screen.getByText(new RegExp(hash))).toBeTruthy()
    const clearButton = screen.getByRole('button', { name: 'Clear this lock and allow a fresh preflight' })
    expect((clearButton as HTMLButtonElement).disabled).toBe(true)
    act(() => screen.getByRole('checkbox', { name: 'I verified this hash was dropped and never mined.' }).click())
    expect((clearButton as HTMLButtonElement).disabled).toBe(false)
    act(() => clearButton.click())
    expect(clearUncertainTransaction).toHaveBeenCalledTimes(1)
  })
})
