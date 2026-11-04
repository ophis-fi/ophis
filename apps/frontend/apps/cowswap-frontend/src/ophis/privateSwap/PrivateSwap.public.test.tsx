import { render, screen } from '@testing-library/react'

import { PrivateSwap } from './PrivateSwap.container'

jest.mock('ophis/hooks/useIsMobileSwap', () => ({ useIsMobileSwap: () => false }))
jest.mock('ophis/mobile/MobileSwapHeading.pure', () => ({ MobileSwapHeading: () => null }))
jest.mock('./privateSwapSession.utils', () => ({ PRIVATE_SWAP_DOCUMENT: false, privateSwapUrl: jest.fn() }))

it('retains the ordinary public swap and wallet controls without loading the private runtime', () => {
  render(<PrivateSwap publicSwap={<button type="button">Connect public swap wallet</button>} />)
  expect(screen.getByRole('button', { name: 'Connect public swap wallet' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: 'Public' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByTitle('Ophis private swap wallet')).toBeNull()
})
