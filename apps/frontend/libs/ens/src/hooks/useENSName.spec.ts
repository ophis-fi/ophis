import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

import useSWR from 'swr'

import { useENSName } from './useENSName'

jest.mock('swr', () => ({ __esModule: true, default: jest.fn(() => ({ data: null, isLoading: false })) }))
jest.mock('@ethersproject/providers', () => ({
  ...jest.requireActual('@ethersproject/providers'),
  JsonRpcProvider: jest.fn(() => ({ lookupAddress: jest.fn(async () => 'alice.eth') })),
}))

it('uses the Ethereum provider for identity, with account-specific cache keys and no invalid-address calls', async () => {
  const alice = '0x1111111111111111111111111111111111111111'
  const bob = '0x2222222222222222222222222222222222222222'
  const swr = jest.mocked(useSWR)
  useENSName(alice)
  expect(JsonRpcProvider).toHaveBeenCalledWith(expect.any(String), SupportedChainId.MAINNET)
  const [key, fetchName] = swr.mock.calls[0]
  expect(key).toEqual(['useENSName', alice])
  expect(typeof fetchName).toBe('function')
  await expect((fetchName as (key: string[]) => Promise<string>)(['useENSName', alice])).resolves.toBe('alice.eth')
  useENSName(bob)
  expect(swr.mock.lastCall?.[0]).toEqual(['useENSName', bob])
  useENSName('invalid')
  expect(swr.mock.lastCall?.[0]).toBeNull()
  useENSName()
  expect(swr.mock.lastCall?.[0]).toBeNull()
})
