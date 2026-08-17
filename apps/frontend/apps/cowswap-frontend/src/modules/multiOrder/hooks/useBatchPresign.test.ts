import { act, renderHook } from '@testing-library/react'
import { useWalletClient } from 'wagmi'

import { useBatchPresign } from './useBatchPresign'

jest.mock('wagmi', () => ({ useWalletClient: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({
  getWalletCapabilitiesForChain: (value: Record<string, unknown> | undefined, chainId: number): unknown =>
    value?.[`0x${chainId.toString(16)}`] ?? value?.[String(chainId)],
  hasAtomicBatchCapability: (value: { atomic?: { status?: unknown } } | undefined): boolean =>
    value?.atomic?.status === 'supported' || value?.atomic?.status === 'ready',
  getWalletCallsId: (value: unknown): string => {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && value.id) {
      return value.id
    }
    throw new Error('Wallet returned an invalid batch identifier')
  },
  parseWalletCallsStatus: (value: unknown, expectedId: string, expectedChainId: number): unknown => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid batch status')
    const status = value as { id?: unknown; chainId?: unknown; status?: unknown; atomic?: unknown }
    if (
      status.id !== expectedId ||
      status.chainId !== `0x${expectedChainId.toString(16)}` ||
      typeof status.status !== 'number' ||
      typeof status.atomic !== 'boolean'
    ) {
      throw new Error('invalid batch status')
    }
    return status
  },
}))

const SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859'

interface TestWalletClient {
  readonly getCapabilities?: () => Promise<unknown>
  readonly sendCalls?: (args: unknown) => Promise<unknown>
  readonly request?: (args: unknown) => Promise<unknown>
}

function setWalletClient(walletClient: TestWalletClient | undefined): void {
  jest.mocked(useWalletClient).mockReturnValue({ data: walletClient } as ReturnType<typeof useWalletClient>)
}

describe('useBatchPresign', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('requires a confirmed capability before sending calls', async () => {
    const sendCalls = jest.fn().mockResolvedValue({ id: '0xabcd' })
    setWalletClient({ sendCalls })
    const { result } = renderHook(() => useBatchPresign(10))

    await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).rejects.toThrow('has not been confirmed')
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('detects exact-chain support and returns a validated batch id', async () => {
    const sendCalls = jest.fn().mockResolvedValue({ id: '0xabcd' })
    setWalletClient({
      getCapabilities: jest.fn().mockResolvedValue({ '0xa': { atomic: { status: 'supported' } } }),
      sendCalls,
    })
    const { result } = renderHook(() => useBatchPresign(10))

    await act(async () => {
      expect(await result.current.detect()).toBe(true)
    })
    await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).resolves.toBe('0xabcd')

    expect(result.current.capable).toBe(true)
    expect(sendCalls).toHaveBeenCalledTimes(1)
    expect(sendCalls).toHaveBeenCalledWith(expect.objectContaining({ forceAtomic: true, version: '2.0.0' }))
  })

  it('disables batching after a rejected wallet call without replaying it', async () => {
    const sendCalls = jest.fn().mockRejectedValue(new Error('wallet rejected batch'))
    setWalletClient({
      getCapabilities: jest.fn().mockResolvedValue({ '0xa': { atomic: { status: 'ready' } } }),
      sendCalls,
    })
    const { result } = renderHook(() => useBatchPresign(10))

    await act(async () => {
      await result.current.detect()
    })
    await act(async () => {
      await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).rejects.toThrow('wallet rejected batch')
    })

    expect(result.current.capable).toBe(false)
    expect(sendCalls).toHaveBeenCalledTimes(1)
  })

  it('disables batching when the wallet returns a malformed batch id', async () => {
    setWalletClient({
      getCapabilities: jest.fn().mockResolvedValue({ '0xa': { atomic: { status: 'supported' } } }),
      sendCalls: jest.fn().mockResolvedValue({}),
    })
    const { result } = renderHook(() => useBatchPresign(10))

    await act(async () => {
      await result.current.detect()
    })
    await act(async () => {
      await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).rejects.toThrow('invalid batch identifier')
    })

    expect(result.current.capable).toBe(false)
  })

  it('disables batching when the wallet omits the send-calls method', async () => {
    setWalletClient({
      getCapabilities: jest.fn().mockResolvedValue({ '0xa': { atomic: { status: 'supported' } } }),
    })
    const { result } = renderHook(() => useBatchPresign(10))

    await act(async () => {
      await result.current.detect()
    })
    await act(async () => {
      await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).rejects.toThrow('does not support')
    })

    expect(result.current.capable).toBe(false)
  })

  it('ignores capability detection that resolves after the chain changes', async () => {
    let resolveCapabilities: ((capabilities: unknown) => void) | undefined
    const capabilitiesPromise = new Promise<unknown>((resolve) => {
      resolveCapabilities = resolve
    })
    setWalletClient({ getCapabilities: jest.fn().mockReturnValue(capabilitiesPromise) })
    const { result, rerender } = renderHook(({ chainId }) => useBatchPresign(chainId), {
      initialProps: { chainId: 10 },
    })
    let detection = Promise.resolve(true)

    act(() => {
      detection = result.current.detect()
    })
    rerender({ chainId: 1 })
    resolveCapabilities?.({ '0xa': { atomic: { status: 'supported' } } })

    await act(async () => {
      expect(await detection).toBe(false)
    })
    expect(result.current.capable).toBeUndefined()
    expect(result.current.isDetecting).toBe(false)
  })

  it('reconciles a batch only for the active wallet and chain', async () => {
    const request = jest.fn().mockResolvedValue({ id: '0xabcd', chainId: '0xa', status: 400, atomic: true })
    setWalletClient({ request })
    const { result } = renderHook(() => useBatchPresign(10))

    await expect(result.current.reconcileBatch('0xabcd')).resolves.toMatchObject({ status: 400 })
    expect(request).toHaveBeenCalledWith({ method: 'wallet_getCallsStatus', params: ['0xabcd'] })
  })

  it('rejects a batch status that resolves after the chain changes', async () => {
    let resolveStatus: ((status: unknown) => void) | undefined
    const statusPromise = new Promise<unknown>((resolve) => {
      resolveStatus = resolve
    })
    const walletClient = { request: jest.fn().mockReturnValue(statusPromise) }
    setWalletClient(walletClient)
    const { result, rerender } = renderHook(({ chainId }) => useBatchPresign(chainId), {
      initialProps: { chainId: 10 },
    })

    const reconciliation = result.current.reconcileBatch('0xabcd')
    rerender({ chainId: 1 })
    resolveStatus?.({ id: '0xabcd', chainId: '0xa', status: 400, atomic: true })

    await expect(reconciliation).rejects.toThrow('wallet changed')
  })
})
