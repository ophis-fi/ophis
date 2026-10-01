import { ReactNode } from 'react'

import { fireEvent, render, screen } from '@testing-library/react'

import { NearSwapRecovery } from './NearSwapRecovery.container'

const mockRefetch = jest.fn()
const mockRead = jest.fn((key) =>
  key === 'transfers'
    ? [{ response: { signature: 'saved' } }]
    : { error: new Error('unavailable'), refetch: mockRefetch },
)
jest.mock('jotai', () => ({ useAtomValue: (key: string) => mockRead(key) }))
jest.mock('./nearDirect.atoms', () => ({ nearTransfersAtom: 'transfers', nearTokensAtom: 'tokens' }))
jest.mock('./NearTransferCard.container', () => ({ NearTransferCard: () => <span>Saved swap</span> }))
jest.mock('./nearDirect.styled', () => ({ Stack: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
jest.mock('@cowprotocol/ui', () => ({ ButtonSecondary: 'button' }))

it('keeps recovery visible and offers asset retry while new swaps are paused', () => {
  render(<NearSwapRecovery allowFunding={false} />)
  expect(screen.getByText('Saved swap')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('Unable to verify swap assets')
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading assets' }))
  expect(mockRefetch).toHaveBeenCalledTimes(1)
})
