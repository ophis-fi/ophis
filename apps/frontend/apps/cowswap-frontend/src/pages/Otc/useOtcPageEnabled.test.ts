import { DEFAULT_FEATURE_FLAGS, useFeatureFlags } from '@cowprotocol/common-hooks'

import { renderHook } from '@testing-library/react'
import { useFlags } from 'launchdarkly-react-client-sdk'

import { isOtcPageEnabled, isOtcWriteEnabled, useOtcPageEnabled } from './useOtcPageEnabled'

jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isLocal: false,
}))

jest.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: jest.fn(),
}))

const mockUseFlags = useFlags as jest.MockedFunction<typeof useFlags>

describe('useOtcPageEnabled', () => {
  beforeEach(() => {
    delete process.env.REACT_APP_OTC_ENABLED
    mockUseFlags.mockReturnValue({})
  })

  afterEach(() => {
    delete process.env.REACT_APP_OTC_ENABLED
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

  it('lets the deployment kill switch override a remote enablement', () => {
    process.env.REACT_APP_OTC_ENABLED = 'false'
    mockUseFlags.mockReturnValue({ isOtcEnabled: true })

    const { result } = renderHook(() => useOtcPageEnabled())

    expect(result.current).toBe(false)
  })

  it('blocks fork writes when the deployment kill switch overrides both enabled remote flags', () => {
    process.env.REACT_APP_OTC_ENABLED = 'false'
    mockUseFlags.mockReturnValue({ isOtcEnabled: true, isOtcWriteEnabled: true })

    const { result } = renderHook(() => useFeatureFlags())

    expect(isOtcWriteEnabled(result.current, true, 'fork', 'true')).toBe(false)
  })
})

describe('OTC feature boundaries', () => {
  it('enables the reviewed Milestone B route from its read-only flag', () => {
    expect(DEFAULT_FEATURE_FLAGS.isOtcEnabled).toBe(true)
    expect(DEFAULT_FEATURE_FLAGS.isOtcWriteEnabled).toBe(false)
    expect(isOtcPageEnabled({ isOtcEnabled: true }, false)).toBe(true)
    expect(isOtcPageEnabled({}, false)).toBe(false)
  })

  it('keeps writes off when only the read-only route is enabled', () => {
    expect(isOtcWriteEnabled({ isOtcEnabled: true }, false, undefined)).toBe(false)
    expect(isOtcWriteEnabled({ isOtcEnabled: true, isOtcWriteEnabled: true }, false, 'fork')).toBe(false)
  })

  it('requires local mode, the write flag, and an explicit fork build together', () => {
    const flags = { isOtcEnabled: true, isOtcWriteEnabled: true }

    expect(isOtcWriteEnabled(flags, true, undefined)).toBe(false)
    expect(isOtcWriteEnabled(flags, true, 'production')).toBe(false)
    expect(isOtcWriteEnabled({ isOtcEnabled: true }, true, 'fork')).toBe(false)
    expect(isOtcWriteEnabled(flags, true, 'fork')).toBe(true)
  })

  it('allows an independent local-only write flag for fork E2E without changing production defaults', () => {
    const flags = { isOtcEnabled: true, isOtcWriteEnabled: false }

    expect(isOtcWriteEnabled(flags, true, 'fork', 'false')).toBe(false)
    expect(isOtcWriteEnabled(flags, false, 'fork', 'true')).toBe(false)
    expect(isOtcWriteEnabled(flags, true, undefined, 'true')).toBe(false)
    expect(isOtcWriteEnabled(flags, true, 'fork', 'true')).toBe(true)
  })
})
