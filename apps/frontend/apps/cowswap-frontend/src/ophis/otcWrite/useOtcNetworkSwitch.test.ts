import { useSwitchNetwork } from '@cowprotocol/wallet'

import { act, renderHook } from '@testing-library/react'

import { useOtcNetworkSwitch } from './useOtcNetworkSwitch'

jest.mock('@cowprotocol/wallet', () => ({ useSwitchNetwork: jest.fn() }))

const switchLegacy = jest.fn()
beforeEach(() => {
  switchLegacy.mockReset().mockResolvedValue(undefined)
  jest.mocked(useSwitchNetwork).mockReturnValue(switchLegacy)
})

it('switches the active Wagmi connector to Ethereum and holds the button pending', async () => {
  let finish: (() => void) | undefined
  const switchChain = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const client = { switchChain } as unknown as Parameters<typeof useOtcNetworkSwitch>[1]
  const error = jest.fn()
  const { result } = renderHook(() => useOtcNetworkSwitch(true, client, error, 'context'))
  let pending: Promise<void> | undefined
  act(() => {
    pending = result.current.switchToEthereum()
    void result.current.switchToEthereum()
  })
  expect(result.current.switching).toBe(true)
  expect(switchChain).toHaveBeenCalledTimes(1)
  expect(switchChain).toHaveBeenCalledWith({ id: 1 })
  expect(switchLegacy).not.toHaveBeenCalled()
  await act(async () => {
    finish?.()
    await pending
  })
  expect(result.current.switching).toBe(false)
})

it('reuses the host switcher for a legacy connector', async () => {
  const error = jest.fn()
  const { result } = renderHook(() => useOtcNetworkSwitch(true, undefined, error, 'context'))
  await act(() => result.current.switchToEthereum())
  expect(switchLegacy).toHaveBeenCalledWith(1)
})

it('keeps fork selection manual and never switches a fork user to real Ethereum', async () => {
  const error = jest.fn()
  const switchChain = jest.fn()
  const client = { switchChain } as unknown as Parameters<typeof useOtcNetworkSwitch>[1]
  const { result } = renderHook(() => useOtcNetworkSwitch(false, client, error, 'context'))
  await act(() => result.current.switchToEthereum())
  expect(switchChain).not.toHaveBeenCalled()
  expect(switchLegacy).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('Anvil fork'))
})

it('surfaces wallet rejection and releases the pending state for another deliberate attempt', async () => {
  switchLegacy.mockRejectedValue(new Error('user rejected'))
  const error = jest.fn()
  const { result } = renderHook(() => useOtcNetworkSwitch(true, undefined, error, 'context'))
  await act(() => result.current.switchToEthereum())
  expect(result.current.switching).toBe(false)
  expect(error).toHaveBeenLastCalledWith(expect.any(String))
})

it.each(['wagmi', 'legacy', 'context'])(
  'isolates pending switches and stale errors across %s changes',
  async (mode) => {
    let rejectFirst: ((error: Error) => void) | undefined
    let resolveSecond: (() => void) | undefined
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })
    const switchA = jest.fn(() => first)
    const switchB = jest.fn(() => second)
    const clientA = { switchChain: switchA } as unknown as Parameters<typeof useOtcNetworkSwitch>[1]
    const clientB = { switchChain: switchB } as unknown as Parameters<typeof useOtcNetworkSwitch>[1]
    jest.mocked(useSwitchNetwork).mockReturnValue(switchA)
    const error = jest.fn()
    const { result, rerender } = renderHook(({ client, key }) => useOtcNetworkSwitch(true, client, error, key), {
      initialProps: { client: mode === 'legacy' ? undefined : clientA, key: 'A' },
    })
    let pendingA: Promise<void> | undefined
    let pendingB: Promise<void> | undefined
    act(() => {
      pendingA = result.current.switchToEthereum()
    })
    expect(result.current.switching).toBe(true)
    if (mode === 'legacy') jest.mocked(useSwitchNetwork).mockReturnValue(switchB)
    if (mode === 'context') switchA.mockReturnValue(second)
    rerender({
      client: mode === 'legacy' ? undefined : mode === 'wagmi' ? clientB : clientA,
      key: mode === 'context' ? 'B' : 'A',
    })
    expect(result.current.switching).toBe(false)
    act(() => {
      pendingB = result.current.switchToEthereum()
    })
    expect(result.current.switching).toBe(true)
    await act(async () => {
      rejectFirst?.(new Error('old wallet rejected'))
      await pendingA
    })
    expect(result.current.switching).toBe(true)
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenLastCalledWith(null)
    await act(async () => {
      resolveSecond?.()
      await pendingB
    })
    expect(result.current.switching).toBe(false)
  },
)

it('ignores a rejection from a switch whose controller was unmounted', async () => {
  let reject: ((error: Error) => void) | undefined
  switchLegacy.mockReturnValue(
    new Promise<void>((_resolve, fail) => {
      reject = fail
    }),
  )
  const error = jest.fn()
  const { result, unmount } = renderHook(() => useOtcNetworkSwitch(true, undefined, error, 'context'))
  let pending: Promise<void> | undefined
  act(() => {
    pending = result.current.switchToEthereum()
  })
  unmount()
  await act(async () => {
    reject?.(new Error('old wallet rejected'))
    await pending
  })
  expect(error).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenLastCalledWith(null)
})
