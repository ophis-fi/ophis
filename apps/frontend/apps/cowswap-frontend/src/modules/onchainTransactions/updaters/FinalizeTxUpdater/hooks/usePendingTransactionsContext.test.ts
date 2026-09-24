import { useGnosisSafeInfo, useWalletInfo } from '@cowprotocol/wallet'
import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { act, renderHook } from '@testing-library/react'

import { useBlockNumber } from 'common/hooks/useBlockNumber'

import { usePendingTransactionsContext } from './usePendingTransactionsContext'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn(), useGnosisSafeInfo: jest.fn() }))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: jest.fn() }))
jest.mock('common/hooks/useBlockNumber', () => ({ useBlockNumber: jest.fn() }))
jest.mock('legacy/hooks/useGetSafeTxInfo', () => ({ useGetSafeTxInfo: jest.fn() }))
jest.mock('legacy/state/hooks', () => ({ useAppDispatch: jest.fn() }))
jest.mock('legacy/state/orders/hooks', () => ({ useCancelOrdersBatch: jest.fn() }))
jest.mock('modules/twap/hooks/useGetTwapOrderById', () => ({ useGetTwapOrderById: jest.fn() }))
jest.mock('common/hooks/useGetReceipt', () => ({ useGetReceipt: jest.fn() }))
jest.mock('lib/hooks/useNativeCurrency', () => ({ __esModule: true, default: jest.fn() }))

test('fetches a fresh nonce only when pending transactions need checking', async () => {
  const account = '0x0000000000000000000000000000000000000001'
  const provider = { getTransactionCount: jest.fn().mockResolvedValue(7) }
  jest.mocked(useWalletProvider).mockReturnValue(provider as unknown as ReturnType<typeof useWalletProvider>)
  jest.mocked(useWalletInfo).mockReturnValue({ account, chainId: 1 } as ReturnType<typeof useWalletInfo>)
  jest.mocked(useGnosisSafeInfo).mockReturnValue(undefined)
  jest.mocked(useBlockNumber).mockReturnValue(100)

  const { result, rerender } = renderHook(({ pending }) => usePendingTransactionsContext(pending), {
    initialProps: { pending: false },
  })
  await act(async () => undefined)
  expect(provider.getTransactionCount).not.toHaveBeenCalled()
  await act(async () => rerender({ pending: true }))
  expect(provider.getTransactionCount).toHaveBeenCalledWith(account)
  expect(result.current?.transactionsCount).toBe(7)

  await act(async () => rerender({ pending: false }))
  jest.mocked(useBlockNumber).mockReturnValue(101)
  await act(async () => rerender({ pending: false }))
  expect(provider.getTransactionCount).toHaveBeenCalledTimes(1)
  expect(result.current).toBeNull()
  await act(async () => rerender({ pending: true }))
  expect(provider.getTransactionCount).toHaveBeenCalledTimes(2)
  expect(result.current?.lastBlockNumber).toBe(101)
})
