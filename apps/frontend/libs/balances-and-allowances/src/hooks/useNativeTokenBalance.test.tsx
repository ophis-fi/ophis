import { ReactNode } from 'react'

import { BigNumber } from '@ethersproject/bignumber'

import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

import { useNativeTokenBalance } from './useNativeTokenBalance'

const mockProvider = { getNetwork: jest.fn() }
const mockBalance = jest.fn()
jest.mock('@cowprotocol/multicall', () => ({
  useMultiCallRpcProvider: () => mockProvider,
  getMulticallContract: () => ({ callStatic: { getEthBalance: mockBalance } }),
}))
const config = { provider: () => new Map(), dedupingInterval: 0 }
function Wrapper({ children }: { children: ReactNode }): ReactNode {
  return <SWRConfig value={config}>{children}</SWRConfig>
}

it('does not reuse another network balance while Ethereum is loading', async () => {
  mockProvider.getNetwork.mockResolvedValue({ chainId: 100 })
  mockBalance.mockResolvedValueOnce(BigNumber.from(1000))
  const { result, rerender } = renderHook(({ chainId }) => useNativeTokenBalance('0x123', chainId), {
    initialProps: { chainId: 100 },
    wrapper: Wrapper,
  })
  await waitFor(() => expect(result.current.data?.toString()).toBe('1000'))
  let finish: (value: BigNumber) => void = () => {}
  mockProvider.getNetwork.mockResolvedValue({ chainId: 1 })
  mockBalance.mockImplementationOnce(
    () =>
      new Promise<BigNumber>((resolve) => {
        finish = resolve
      }),
  )
  rerender({ chainId: 1 })
  expect(result.current.data).toBeUndefined()
  await waitFor(() => expect(mockBalance).toHaveBeenCalledTimes(2))
  await act(async () => finish(BigNumber.from(0)))
  await waitFor(() => expect(result.current.data?.toString()).toBe('0'))
})
