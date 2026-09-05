import { Provider } from 'jotai'
import { createElement, type ReactNode } from 'react'

import { act, renderHook, waitFor } from '@testing-library/react'

import { getOtcWalletForkId, toOtcForkClients, verifyOtcLocalForkWallet } from './otcWriteAdapters'
import { readOtcAllowance } from './readOtcAllowance'
import {
  getOtcWalletTransportId,
  retryOtcForkVerification,
  useOtcNetworkReads,
  withOtcAllowanceReadTimeout,
  withOtcForkVerificationTimeout,
} from './useOtcNetworkReads'

jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: jest.fn(() => undefined) }))
jest.mock('./readOtcAllowance', () => ({ readOtcAllowance: jest.fn() }))
jest.mock('./otcWriteAdapters', () => ({
  getOtcWalletForkId: jest.fn(),
  getOtcProviderForkId: jest.fn(),
  toOtcForkClients: jest.fn(),
  toOtcLegacyForkClients: jest.fn(),
  verifyOtcLocalForkProvider: jest.fn(),
  verifyOtcLocalForkWallet: jest.fn(),
}))

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const FORK_ID = `0x${'aa'.repeat(32)}` as const
const TOKEN = '0x2222222222222222222222222222222222222222'

interface HookProps {
  account: Parameters<typeof useOtcNetworkReads>[1]
}

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  return createElement(Provider, null, children)
}

describe('getOtcWalletTransportId', () => {
  it('is stable per transport and partitions distinct fork providers', () => {
    const first = {}
    const second = {}

    expect(getOtcWalletTransportId(first)).toBe(getOtcWalletTransportId(first))
    expect(getOtcWalletTransportId(first)).not.toBe(getOtcWalletTransportId(second))
    expect(getOtcWalletTransportId(undefined)).toBe(0)
  })
})

describe('useOtcNetworkReads', () => {
  it('starts the read-only allowance query without waiting for fork verification to settle', async () => {
    const walletClient = {} as Parameters<typeof toOtcForkClients>[0]
    jest.mocked(toOtcForkClients).mockReturnValue({ writeClient: {} as never, wallet: {} as never })
    jest.mocked(getOtcWalletForkId).mockResolvedValue(FORK_ID)
    jest.mocked(readOtcAllowance).mockResolvedValue({ allowance: 0n, blockNumber: 1n })
    let finishVerification: ((verified: boolean) => void) | undefined
    jest.mocked(verifyOtcLocalForkWallet).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve
        }),
    )

    const { result, rerender } = renderHook(
      ({ account }: HookProps) => useOtcNetworkReads(true, account, 1, walletClient, TOKEN),
      { initialProps: { account: undefined }, wrapper: Wrapper },
    )

    expect(readOtcAllowance).not.toHaveBeenCalled()
    rerender({ account: ACCOUNT })
    await waitFor(() => expect(readOtcAllowance).toHaveBeenCalledTimes(1))
    expect(result.current.localForkResponse.data).toBeUndefined()
    await waitFor(() => expect(finishVerification).toBeDefined())
    await act(async () => finishVerification?.(true))
    await waitFor(() => expect(result.current.localForkResponse.data).toBe(FORK_ID))
  })
})

describe('withOtcForkVerificationTimeout', () => {
  it('fails a stalled wallet RPC verification closed', async () => {
    jest.useFakeTimers()
    try {
      const result = withOtcForkVerificationTimeout(new Promise<boolean>(() => undefined))
      const rejection = expect(result).rejects.toThrow('Ophis OTC local fork verification timed out')

      await jest.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('withOtcAllowanceReadTimeout', () => {
  it('fails a stalled allowance RPC closed', async () => {
    jest.useFakeTimers()
    try {
      const result = withOtcAllowanceReadTimeout(new Promise<never>(() => undefined))
      const rejection = expect(result).rejects.toThrow('Ophis OTC allowance read timed out')

      await jest.advanceTimersByTimeAsync(30_000)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('retryOtcForkVerification', () => {
  it('accepts only after a real fork verification succeeds', async () => {
    jest.useFakeTimers()
    try {
      const verify = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const result = retryOtcForkVerification(verify)

      await jest.advanceTimersByTimeAsync(750)

      await expect(result).resolves.toBe(true)
      expect(verify).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
