import { ReactNode } from 'react'

import { isInjectedWidget } from '@cowprotocol/common-utils'

import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { useIsCctpEnabled } from './useIsCctpEnabled'

jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: jest.fn(() => false) }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('common/constants/routes', () => ({
  Routes: { SWAP: '/:chainId/swap/:input?/:output?', HOOKS: '/:chainId/swap/hooks/:input?/:output?' },
}))

it.each([
  ['/1/swap/USDC/USDC', false, true],
  ['/1/swap/hooks', false, false],
  ['/1/swap/hooks/USDC/USDC', false, false],
  ['/1/swap/USDC/USDC', true, false],
  ['/1/limit/USDC/EURC', false, false],
] as const)('matches executable CCTP surface %s (injected=%s)', (path, injected, enabled) => {
  jest.mocked(isInjectedWidget).mockReturnValue(injected)
  const { result } = renderHook(() => useIsCctpEnabled(), {
    wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
  })
  expect(result.current).toBe(enabled)
})
