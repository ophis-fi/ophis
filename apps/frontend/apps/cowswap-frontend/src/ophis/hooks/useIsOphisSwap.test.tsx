import { isInjectedWidget } from '@cowprotocol/common-utils'

import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { useIsOphisSwap } from './useIsOphisSwap'

jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: jest.fn() }))

describe('standalone Ophis swap styling', () => {
  it.each([
    ['/swap', false, true],
    ['/1/swap/USDC/ETH', false, true],
    ['/10/swap/USDC/ETH', false, true],
    ['/swap/hooks', false, false],
    ['/1/swap/hooks/edit', false, false],
    ['/swapfoo', false, false],
    ['/1/limit/USDC/ETH', false, false],
    ['/1/swap/USDC/ETH', true, false],
  ])('route %s, embed %s → %s', (path, embed, expected) => {
    jest.mocked(isInjectedWidget).mockReturnValue(embed)
    const { result } = renderHook(useIsOphisSwap, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
    })
    expect(result.current).toBe(expected)
  })
})
