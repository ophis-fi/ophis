/**
 * useTier privacy gate (Phase 3 audit M).
 *
 * Critical contract: until the user explicitly opts in, fetch() MUST
 * NOT be called. This locks in the privacy guarantee against any
 * future refactor that might accidentally lift the gate.
 */
import { act, renderHook } from '@testing-library/react'

import { REBATES_OPT_IN_KEY, setRebatesOptIn } from './useRebatesOptIn'
import { useTier } from './useTier'

describe('useTier privacy gate', () => {
  beforeEach(() => {
    window.localStorage.removeItem(REBATES_OPT_IN_KEY)
    ;(globalThis.fetch as unknown) = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            wallet: '0x0000000000000000000000000000000000000001',
            volume_30d_usd: 1234,
            trade_count_30d: 5,
            tier: { name: 'none', min_usd: 0, rebate_pct: 0 },
            next_tier: { name: 'bronze', min_usd: 20_000, rebate_pct: 0.1 },
            usd_to_next_tier: 18_766,
          }),
      }) as unknown as Promise<Response>,
    )
  })

  afterEach(() => {
    jest.restoreAllMocks()
    window.localStorage.removeItem(REBATES_OPT_IN_KEY)
  })

  it('does NOT call fetch when not opted in (privacy default)', async () => {
    const wallet = '0x0000000000000000000000000000000000000001' as const
    const { result } = renderHook(() => useTier(wallet))

    expect(result.current.optedIn).toBe(false)
    expect(result.current.data).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('calls fetch once after opt-in flips', async () => {
    const wallet = '0x0000000000000000000000000000000000000001' as const
    const { result, rerender } = renderHook(() => useTier(wallet))
    expect(globalThis.fetch).not.toHaveBeenCalled()

    await act(async () => {
      setRebatesOptIn(true)
    })
    rerender()
    expect(result.current.optedIn).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/tier/${wallet.toLowerCase()}`),
    )
  })

  it('clears data when opt-in is revoked mid-session', async () => {
    window.localStorage.setItem(REBATES_OPT_IN_KEY, 'true')
    const wallet = '0x0000000000000000000000000000000000000001' as const
    const { result, rerender } = renderHook(() => useTier(wallet))

    // Let the fetch resolve.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.optedIn).toBe(true)

    await act(async () => {
      setRebatesOptIn(false)
    })
    rerender()
    expect(result.current.optedIn).toBe(false)
    expect(result.current.data).toBeNull()
  })

  it('does NOT call fetch when wallet is undefined, regardless of opt-in', () => {
    window.localStorage.setItem(REBATES_OPT_IN_KEY, 'true')
    renderHook(() => useTier(undefined))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
