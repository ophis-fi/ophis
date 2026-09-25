import { render, screen } from '@testing-library/react'

import { CctpSwapRecovery } from './Cctp.container'
import { type useCctpSwapRoute } from './useCctpSwapRoute'

jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: jest.fn() }))

it('keeps the CCTP constraint visible without replacing generic provider actions', () => {
  const route = {
    active: false,
    asset: 'USDC',
    blocked: 'CCTP delivers to your connected wallet. Clear the custom recipient to continue.',
    flow: { transfer: null },
  } as ReturnType<typeof useCctpSwapRoute>
  const { rerender } = render(<CctpSwapRecovery route={route} />)
  expect(screen.getByRole('status').textContent).toBe(route.blocked)
  expect(screen.queryByRole('button')).toBeNull()
  rerender(<CctpSwapRecovery route={{ ...route, asset: undefined }} />)
  expect(screen.queryByRole('status')).toBeNull()
})
