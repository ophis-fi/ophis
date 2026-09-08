import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { OTC_CANARY_POLICY } from './otcCanary.const'
import { useOtcWriteAuthorization } from './otcWriteAuthorization'

jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: () => ({ isOtcEnabled: true, isOtcWriteEnabled: true }),
}))
jest.mock('./otcCanary.const', () => ({ OTC_CANARY_POLICY: { accounts: ['test-only'], pairs: [], expiresAt: 0n } }))

it.each(['canary', 'public'])('%s keeps tracking through runtime shutdown', async (mode) => {
  const originalFetch = global.fetch
  const originalMode = process.env.REACT_APP_OTC_WRITE_MODE
  process.env.REACT_APP_OTC_WRITE_MODE = mode
  Object.assign(OTC_CANARY_POLICY, { accounts: mode === 'public' ? [] : ['test-only'] })
  jest.useFakeTimers()
  const response = { enabled: true, offline: false }
  global.fetch = jest.fn(async (url) => {
    if (response.offline) throw new Error('offline')
    return {
      ok: true,
      json: async () => ({
        enabled: response.enabled,
        nonce: new URL(String(url), 'https://swap.ophis.fi').searchParams.get('nonce'),
      }),
    } as Response
  })
  try {
    const first = renderHook(() => useOtcWriteAuthorization())
    expect(first.result.current).toMatchObject({ enabled: false, configured: true })
    await waitFor(() => expect(first.result.current.enabled).toBe(true))
    response.enabled = false
    await act(() => jest.advanceTimersByTimeAsync(5_001))
    await waitFor(() => expect(first.result.current).toMatchObject({ enabled: false, configured: true }))
    response.enabled = true
    await act(() => jest.advanceTimersByTimeAsync(5_001))
    await waitFor(() => expect(first.result.current.enabled).toBe(true))
    response.offline = true
    await act(() => jest.advanceTimersByTimeAsync(5_001))
    await waitFor(() => expect(first.result.current.enabled).toBe(false))
    first.unmount()
    const fresh = renderHook(() => useOtcWriteAuthorization())
    expect(fresh.result.current).toMatchObject({ enabled: false, configured: true })
  } finally {
    cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
    global.fetch = originalFetch
    if (originalMode === undefined) delete process.env.REACT_APP_OTC_WRITE_MODE
    else process.env.REACT_APP_OTC_WRITE_MODE = originalMode
  }
})
