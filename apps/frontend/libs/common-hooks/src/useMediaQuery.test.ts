import { act, renderHook } from '@testing-library/react'

import { useMediaQuery } from './useMediaQuery'

it('uses the phone viewport on first render and follows viewport changes', () => {
  const addEventListener = jest.fn()
  const removeEventListener = jest.fn()
  const previousMatchMedia = window.matchMedia
  window.matchMedia = jest.fn().mockReturnValue({
    matches: true,
    addEventListener,
    removeEventListener,
  } as unknown as MediaQueryList)
  const renders: boolean[] = []
  const { result, unmount } = renderHook(() => {
    const matches = useMediaQuery('(max-width: 720px)')
    renders.push(matches)
    return matches
  })

  expect(renders[0]).toBe(true)
  act(() => addEventListener.mock.calls[0][1]({ matches: false }))
  expect(result.current).toBe(false)
  unmount()
  expect(removeEventListener).toHaveBeenCalledWith('change', addEventListener.mock.calls[0][1])
  window.matchMedia = previousMatchMedia
})
