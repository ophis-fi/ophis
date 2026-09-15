import { useENSName } from '@cowprotocol/ens'
import { JsonRpcProvider } from '@ethersproject/providers'

import { renderHook, waitFor } from '@testing-library/react'

const mockLookup = jest.fn()
jest.mock('@ethersproject/providers', () => ({
  ...jest.requireActual('@ethersproject/providers'),
  JsonRpcProvider: jest.fn(() => ({ lookupAddress: (address: string) => mockLookup(address) })),
}))

it('keeps Ethereum identity stable across rerenders and clears it when the wallet changes or disconnects', async () => {
  const alice = '0x1111111111111111111111111111111111111111'
  const bob = '0x2222222222222222222222222222222222222222'
  mockLookup.mockImplementation(async (address: string) => (address === alice ? 'alice.eth' : null))
  const { result, rerender, unmount } = renderHook(({ address }) => useENSName(address), {
    initialProps: { address: alice },
  })
  expect(JsonRpcProvider).toHaveBeenCalledWith(expect.any(String), 1)
  await waitFor(() => expect(result.current.ENSName).toBe('alice.eth'))
  const settled = result.current
  rerender({ address: alice })
  expect(result.current).toBe(settled)
  rerender({ address: bob })
  expect(result.current.ENSName).toBeNull()
  await waitFor(() => expect(mockLookup).toHaveBeenCalledWith(bob))
  rerender({ address: 'invalid' })
  expect(result.current).toEqual({ ENSName: null, loading: false })
  rerender({ address: '' })
  expect(result.current).toEqual({ ENSName: null, loading: false })
  expect(mockLookup).toHaveBeenCalledTimes(2)
  unmount()
})
