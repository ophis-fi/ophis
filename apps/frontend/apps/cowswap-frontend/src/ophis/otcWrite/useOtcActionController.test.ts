import { getDefaultStore } from 'jotai'

import { getAddressKey } from '@cowprotocol/cow-sdk'
import { AccountType } from '@cowprotocol/types'

import { act, renderHook } from '@testing-library/react'
import { recordUncertainOtcTransaction, uncertainOtcTransactionsAtom } from 'entities/otc'
import { installOtcWebLocksMock } from 'entities/otc/otcWebLocks.test.utils'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { MAKER as mockMaker, mockOtcOrder, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcActionController, type OtcActionDefinition } from './useOtcActionController'
import { useOtcNetworkReads, type OtcNetworkReads } from './useOtcNetworkReads'

let mockAccountType: AccountType | undefined = AccountType.EOA
let mockContractWallet: boolean | undefined = false
let mockSafeApp = false

let mockWriteMode: 'fork' | 'canary' | 'public' = 'fork'

jest.mock('@cowprotocol/wallet', () => ({
  useAccountType: () => mockAccountType,
  useWalletDetails: () => ({ isSmartContractWallet: mockContractWallet, isSafeApp: mockSafeApp }),
  useSwitchNetwork: () => jest.fn(),
  useWalletInfo: () => ({ account: mockMaker, chainId: 1 }),
}))
jest.mock('wagmi', () => ({ useWalletClient: () => ({ data: undefined }) }))
jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: () => jest.fn() }))
jest.mock('./otcWriteAuthorization', () => ({
  useOtcWriteAuthorization: () => ({
    enabled: true,
    configured: true,
    authorization: { readFlag: true, writeFlag: true, isLocal: true, writeMode: mockWriteMode },
  }),
}))
jest.mock('./useOtcNetworkReads', () => ({ useOtcNetworkReads: jest.fn() }))
jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))

beforeEach(() => {
  installOtcWebLocksMock()
  mockWriteMode = 'fork'
  mockAccountType = AccountType.EOA
  mockContractWallet = false
  mockSafeApp = false
})

it('isolates recovery by stable fork ID and verifies the origin again before clearing', async () => {
  getDefaultStore().set(uncertainOtcTransactionsAtom, {})
  const forkA = `0x${'aa'.repeat(32)}` as const
  const forkB = `0x${'bb'.repeat(32)}` as const
  const mutate = jest.fn().mockResolvedValue(forkB)
  const network: OtcNetworkReads = {
    transportId: 1,
    writeClient: {} as OtcNetworkReads['writeClient'],
    wallet: {} as OtcNetworkReads['wallet'],
    networkResponse: { data: forkA, error: null, mutate },
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
  network.networkResponse = { ...network.networkResponse, data: forkB }
  rerender()
  expect(result.current.uncertainHash).toBeNull()
  network.networkResponse = { ...network.networkResponse, data: forkA }
  rerender()
  expect(result.current.uncertainHash).toBe(TX_HASH)
  await act(async () => result.current.clearUncertainTransaction())
  expect(result.current.uncertainHash).toBe(TX_HASH)
  mutate.mockResolvedValue(forkA)
  await act(async () => result.current.clearUncertainTransaction())
  expect(result.current.uncertainHash).toBeNull()
})

it.each([
  { mode: 'canary' as const, hash: null },
  { mode: 'canary' as const, hash: TX_HASH },
  { mode: 'public' as const, hash: null },
  { mode: 'public' as const, hash: TX_HASH },
])(
  'reconciles a $mode attempt ($hash) through the actual action controller with canonical network verification',
  async ({ mode, hash }) => {
    mockWriteMode = mode
    const proof = { requestHash: TX_HASH, nonce: 3 }
    const key = `${getAddressKey(mockMaker)}\u0000ethereum-mainnet\u0000order-7`
    getDefaultStore().set(uncertainOtcTransactionsAtom, recordUncertainOtcTransaction({}, key, hash, undefined, proof))
    const mutate = jest.fn().mockResolvedValue('ethereum-mainnet')
    const waitForTransactionReceipt = jest
      .fn()
      .mockResolvedValue({ transactionHash: TX_HASH, status: 'success', blockNumber: 201n })
    jest.mocked(useOtcNetworkReads).mockReturnValue({
      transportId: 1,
      writeClient: null,
      wallet: { sendTransaction: jest.fn(), waitForTransactionReceipt },
      networkResponse: { data: 'ethereum-mainnet', error: null, mutate },
      allowanceResponse: { data: undefined, error: null, mutate: jest.fn() },
    })
    const definition: OtcActionDefinition = {
      executeLabel: 'Cancel order',
      ready: false,
      reviewed: false,
      resetKey: 'order-7',
      executeIntent: null,
    }
    const { result } = renderHook(() => useOtcActionController(definition, undefined))
    expect(result.current.mainnet).toBe(true)
    expect(result.current.signatureUncertain).toBe(hash === null)
    await act(async () => result.current.clearUncertainTransaction(TX_HASH))
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(TX_HASH, proof)
    expect(result.current.successHash).toBe(TX_HASH)
    expect(result.current.uncertainHash).toBeNull()
    expect(getDefaultStore().get(uncertainOtcTransactionsAtom)[key]).toBeUndefined()
  },
)

it.each([
  { type: AccountType.SMART_CONTRACT, contract: true, safe: false },
  { type: undefined, contract: false, safe: false },
  { type: AccountType.EOA, contract: false, safe: true },
])('blocks public actions for unsupported or unknown wallet classification: %s', async ({ type, contract, safe }) => {
  mockWriteMode = 'public'
  mockAccountType = type
  mockContractWallet = contract
  mockSafeApp = safe
  const send = jest.mocked(submitOtcTransaction)
  send.mockClear()
  jest.mocked(useOtcNetworkReads).mockReturnValue({
    transportId: 1,
    writeClient: null,
    wallet: null,
    networkResponse: { data: 'ethereum-mainnet', error: null, mutate: jest.fn() },
    allowanceResponse: { data: undefined, error: null, mutate: jest.fn() },
  })
  const { result } = renderHook(() =>
    useOtcActionController(
      {
        executeLabel: 'Cancel order',
        ready: true,
        reviewed: true,
        resetKey: 'unsupported',
        executeIntent: { kind: 'cancel', account: mockMaker, order: mockOtcOrder() },
      },
      undefined,
    ),
  )
  expect(result.current.model.disabled).toBe(true)
  expect(result.current.model.label).toContain('not supported or admitted')
  await act(() => result.current.runPrimary())
  expect(send).not.toHaveBeenCalled()
})
