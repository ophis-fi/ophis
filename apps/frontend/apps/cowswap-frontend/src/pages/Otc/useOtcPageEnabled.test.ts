import { DEFAULT_FEATURE_FLAGS } from '@cowprotocol/common-hooks'

import { isOtcPageEnabled, isOtcWriteEnabled } from './useOtcPageEnabled'

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
