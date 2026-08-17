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
}))

const SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859'

interface TestWalletClient {
  readonly getCapabilities?: () => Promise<unknown>
  readonly sendCalls?: (args: unknown) => Promise<unknown>
}

function setWalletClient(walletClient: TestWalletClient | undefined): void {
  jest.mocked(useWalletClient).mockReturnValue({ data: walletClient } as ReturnType<typeof useWalletClient>)
}

describe('useBatchPresign', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('requires a confirmed capability before sending calls', async () => {
    const sendCalls = jest.fn().mockResolvedValue({ id: '0xbatch' })
    setWalletClient({ sendCalls })
    const { result } = renderHook(() => useBatchPresign(10))

    await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).rejects.toThrow('has not been confirmed')
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('detects exact-chain support and returns a validated batch id', async () => {
    const sendCalls = jest.fn().mockResolvedValue({ id: '0xbatch' })
    setWalletClient({
      getCapabilities: jest.fn().mockResolvedValue({ '0xa': { atomic: { status: 'supported' } } }),
      sendCalls,
    })
    const { result } = renderHook(() => useBatchPresign(10))

    await act(async () => {
      expect(await result.current.detect()).toBe(true)
    })
    await expect(result.current.presignBatch(['0x01'], SETTLEMENT)).resolves.toBe('0xbatch')

    expect(result.current.capable).toBe(true)
    expect(sendCalls).toHaveBeenCalledTimes(1)
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
})
