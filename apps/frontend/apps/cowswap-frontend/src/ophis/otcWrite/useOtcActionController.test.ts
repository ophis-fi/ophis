import { getDefaultStore } from 'jotai'

import { act, renderHook } from '@testing-library/react'
import { uncertainOtcTransactionsAtom } from 'entities/otc'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { MAKER as mockMaker, mockOtcOrder, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcActionController, type OtcActionDefinition } from './useOtcActionController'
import { useOtcNetworkReads, type OtcNetworkReads } from './useOtcNetworkReads'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ account: mockMaker, chainId: 1 }) }))
jest.mock('wagmi', () => ({ useWalletClient: () => ({ data: undefined }) }))
jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: () => jest.fn() }))
jest.mock('./otcWriteAuthorization', () => ({
  useOtcWriteAuthorization: () => ({
    enabled: true,
    authorization: { readFlag: true, writeFlag: true, isLocal: true, writeMode: 'fork' },
  }),
}))
jest.mock('./useOtcNetworkReads', () => ({ useOtcNetworkReads: jest.fn() }))
jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))

it('isolates recovery by stable fork ID and verifies the origin again before clearing', async () => {
  getDefaultStore().set(uncertainOtcTransactionsAtom, {})
  const forkA = `0x${'aa'.repeat(32)}` as const
  const forkB = `0x${'bb'.repeat(32)}` as const
  const mutate = jest.fn().mockResolvedValue(forkB)
  const network: OtcNetworkReads = {
    transportId: 1,
    writeClient: {} as OtcNetworkReads['writeClient'],
    wallet: {} as OtcNetworkReads['wallet'],
    localForkResponse: { data: forkA, error: null, mutate },
    allowanceResponse: { data: undefined, error: null, mutate: jest.fn() },
  }
  jest.mocked(useOtcNetworkReads).mockReturnValue(network)
  jest.mocked(submitOtcTransaction).mockRejectedValue(new OtcReceiptTrackingError(TX_HASH, new Error('timeout')))
  const definition: OtcActionDefinition = {
    executeLabel: 'Cancel order',
    ready: true,
    reviewed: true,
    resetKey: 'order-7',
    executeIntent: { kind: 'cancel', account: mockMaker, order: mockOtcOrder() },
  }
  const { result, rerender } = renderHook(() => useOtcActionController(definition, undefined))
  await act(() => result.current.runPrimary())
  expect(result.current.uncertainHash).toBe(TX_HASH)
  network.localForkResponse = { ...network.localForkResponse, data: forkB }
  rerender()
  expect(result.current.uncertainHash).toBeNull()
  network.localForkResponse = { ...network.localForkResponse, data: forkA }
  rerender()
  expect(result.current.uncertainHash).toBe(TX_HASH)
  await act(async () => result.current.clearUncertainTransaction())
  expect(result.current.uncertainHash).toBe(TX_HASH)
  mutate.mockResolvedValue(forkA)
  await act(async () => result.current.clearUncertainTransaction())
  expect(result.current.uncertainHash).toBeNull()
})
