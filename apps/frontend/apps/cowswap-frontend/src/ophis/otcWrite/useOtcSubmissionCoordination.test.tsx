import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { type ReactNode } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import { act, renderHook } from '@testing-library/react'
import { uncertainOtcTransactionsAtom } from 'entities/otc'
import { installOtcWebLocksMock } from 'entities/otc/otcWebLocks.test.utils'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { MAKER, mockOtcOrder, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcSubmission, type OtcSubmissionOptions } from './useOtcSubmission'

jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))

function mountTab(): ReturnType<typeof renderHook<ReturnType<typeof useOtcSubmission>, unknown>> {
  const store = createStore()
  const options: OtcSubmissionOptions = {
    writeClient: {} as OtcSubmissionOptions['writeClient'],
    wallet: {} as OtcSubmissionOptions['wallet'],
    authorization: { isLocal: true, readFlag: true, writeFlag: true, writeMode: 'fork' },
    resetKey: 'fork-a:order-7',
    account: MAKER,
    requiredAllowance: null,
    refreshAllowance: jest.fn(),
    onConfirmed: undefined,
  }
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return <Provider store={store}>{children}</Provider>
  }
  return renderHook(() => useOtcSubmission(options), { wrapper: Wrapper })
}

beforeEach(() => {
  localStorage.clear()
  jest.mocked(submitOtcTransaction).mockReset()
  installOtcWebLocksMock()
})

it('blocks a stale tab from resubmitting an uncertain intent before a storage event arrives', async () => {
  const first = mountTab()
  const second = mountTab()
  const intent = { kind: 'cancel' as const, account: MAKER, order: mockOtcOrder() }
  jest.mocked(submitOtcTransaction).mockRejectedValue(new OtcReceiptTrackingError(TX_HASH, new Error('timeout')))
  await act(() => first.result.current.submit(intent, true))
  expect(second.result.current.uncertainHash).toBeNull()

  await act(() => second.result.current.submit(intent, true))

  expect(submitOtcTransaction).toHaveBeenCalledTimes(1)
  expect(second.result.current.uncertainHash).toBe(TX_HASH)
})

it('keeps a newer persisted hash when clearing a stale acknowledged warning', async () => {
  const tab = mountTab()
  const intent = { kind: 'cancel' as const, account: MAKER, order: mockOtcOrder() }
  jest.mocked(submitOtcTransaction).mockRejectedValue(new OtcReceiptTrackingError(TX_HASH, new Error('timeout')))
  await act(() => tab.result.current.submit(intent, true))
  const clearAcknowledgedHash = tab.result.current.clearUncertainTransaction
  const replacementHash = `0x${'ef'.repeat(32)}` as const
  const otherTab = createStore()
  otherTab.set(uncertainOtcTransactionsAtom, {
    [`${getAddressKey(MAKER)}\u0000fork-a:order-7`]: { transactionHash: replacementHash, recordedAt: 1 },
  })

  await act(() => clearAcknowledgedHash(async () => undefined))

  expect(tab.result.current.uncertainHash).toBe(replacementHash)
})
