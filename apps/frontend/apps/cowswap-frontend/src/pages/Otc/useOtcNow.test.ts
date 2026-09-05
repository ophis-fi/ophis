import { act, renderHook } from '@testing-library/react'

import { useOtcNow } from './useOtcNow'

describe('useOtcNow', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('advances the relative-age clock while the page remains mounted', () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_800_000_000_000)
    const { result } = renderHook(() => useOtcNow())

    expect(result.current).toBe(1_800_000_000_000)
    act(() => {
      jest.advanceTimersByTime(60_000)
    })

    expect(result.current).toBe(1_800_000_060_000)
  })
})
