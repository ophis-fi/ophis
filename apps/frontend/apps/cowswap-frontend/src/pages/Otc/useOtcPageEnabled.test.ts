import { renderHook } from '@testing-library/react'
import { useFlags } from 'launchdarkly-react-client-sdk'

import { useOtcPageEnabled } from './useOtcPageEnabled'

jest.mock('@cowprotocol/common-utils', () => ({
  isLocal: false,
}))

jest.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: jest.fn(),
}))

const mockUseFlags = useFlags as jest.MockedFunction<typeof useFlags>

describe('useOtcPageEnabled', () => {
  beforeEach(() => {
    mockUseFlags.mockReturnValue({})
  })

  it('enables the read-only OTC surface by default in production', () => {
    const { result } = renderHook(() => useOtcPageEnabled())

    expect(result.current).toBe(true)
  })

  it('lets an explicit remote flag disable the OTC surface', () => {
    mockUseFlags.mockReturnValue({ isOtcEnabled: false })

    const { result } = renderHook(() => useOtcPageEnabled())

    expect(result.current).toBe(false)
  })
})
