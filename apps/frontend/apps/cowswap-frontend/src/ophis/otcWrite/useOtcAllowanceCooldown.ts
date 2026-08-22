import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { withOtcAllowanceRefreshTimeout } from './otcWriteTimeouts'

const ALLOWANCE_CONFIRMATION_COOLDOWN_MS = 4_000

export function useOtcAllowanceCooldown(
  refreshAllowance: () => Promise<unknown>,
  resetKey: string,
): readonly [boolean, () => void] {
  const [cooldown, setCooldown] = useState(false)
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  useLayoutEffect(() => {
    generationRef.current += 1
    setCooldown(false)
    if (cooldownRef.current) clearTimeout(cooldownRef.current)
    cooldownRef.current = null
    return () => {
      if (cooldownRef.current) clearTimeout(cooldownRef.current)
    }
  }, [resetKey])
  const begin = useCallback(() => {
    const generation = generationRef.current
    setCooldown(true)
    if (cooldownRef.current) clearTimeout(cooldownRef.current)
    cooldownRef.current = setTimeout(() => {
      void withOtcAllowanceRefreshTimeout(refreshAllowance)
        .catch(() => undefined)
        .finally(() => {
          if (generationRef.current === generation) setCooldown(false)
        })
    }, ALLOWANCE_CONFIRMATION_COOLDOWN_MS)
  }, [refreshAllowance])
  return useMemo(() => [cooldown, begin] as const, [begin, cooldown])
}
