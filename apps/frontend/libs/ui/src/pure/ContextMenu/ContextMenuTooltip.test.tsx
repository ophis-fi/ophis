import { ReactNode } from 'react'

import { fireEvent, render, screen } from '@testing-library/react'

import { ContextMenuTooltip } from './ContextMenuTooltip'

jest.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}))

describe('ContextMenuTooltip', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    })
  })

  it('opens from the keyboard', () => {
    render(
      <ContextMenuTooltip ariaLabel="View contract details" content={<span>Contract details</span>}>
        <span>Info</span>
      </ContextMenuTooltip>,
    )

    const trigger = screen.getByRole('button', { name: 'View contract details' })

    expect(trigger.getAttribute('tabindex')).toBe('0')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})
