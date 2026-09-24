import { useIsWindowVisible } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useWalletChainId, useWalletProvider } from '@cowprotocol/wallet-provider'

import { act, renderHook } from '@testing-library/react'

import { EventEmitter } from 'events'

import { BlockNumberProvider } from './BlockNumberProvider'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsWindowVisible: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletChainId: jest.fn(), useWalletProvider: jest.fn() }))

test('reads once disconnected, polls connected, and unsubscribes when hidden or disconnected', async () => {
  const provider = Object.assign(new EventEmitter(), { getBlockNumber: jest.fn().mockResolvedValue(100) })
  const wallet = { account: undefined as string | undefined }
  jest.mocked(useWalletProvider).mockReturnValue(provider as unknown as ReturnType<typeof useWalletProvider>)
  jest.mocked(useWalletInfo).mockImplementation(() => wallet as ReturnType<typeof useWalletInfo>)
  jest.mocked(useWalletChainId).mockReturnValue(1)
  jest.mocked(useIsWindowVisible).mockReturnValue(true)

  const { rerender, unmount } = renderHook(() => null, { wrapper: BlockNumberProvider })
  await act(async () => undefined)
  expect(provider.getBlockNumber).toHaveBeenCalledTimes(1)
  expect(provider.listenerCount('block')).toBe(0)

  wallet.account = '0x0000000000000000000000000000000000000001'
  await act(async () => rerender())
  expect(provider.getBlockNumber).toHaveBeenCalledTimes(2)
  expect(provider.listenerCount('block')).toBe(1)

  jest.mocked(useIsWindowVisible).mockReturnValue(false)
  await act(async () => rerender())
  expect(provider.listenerCount('block')).toBe(0)
  expect(provider.getBlockNumber).toHaveBeenCalledTimes(2)

  jest.mocked(useIsWindowVisible).mockReturnValue(true)
  await act(async () => rerender())
  expect(provider.listenerCount('block')).toBe(1)
  wallet.account = undefined
  await act(async () => rerender())
  expect(provider.listenerCount('block')).toBe(0)
  unmount()
})
