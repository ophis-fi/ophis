import { renderHook } from '@testing-library/react'

import { useSolversFeatureFlag } from '../../hooks/useSolversFeatureFlag'

// LaunchDarkly was removed from the Ophis fork; the hook is now a static stub.
describe('useSolversFeatureFlag', () => {
  it('returns false now that LaunchDarkly is removed (Solvers statically disabled)', () => {
    const { result } = renderHook(() => useSolversFeatureFlag())

    expect(result.current).toBe(false)
  })
})
