import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ALLOWANCE_CONFIRMATION_COOLDOWN_MS = 4_000

export function useOtcAllowanceCooldown(refreshAllowance: () => Promise<unknown>): readonly [boolean, () => void] {
  const [cooldown, setCooldown] = useState(false)
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (cooldownRef.current) clearTimeout(cooldownRef.current)
    },
    [],
  )
  const begin = useCallback(() => {
    setCooldown(true)
    if (cooldownRef.current) clearTimeout(cooldownRef.current)
    cooldownRef.current = setTimeout(() => {
      void refreshAllowance()
        .catch(() => undefined)
        .finally(() => setCooldown(false))
    }, ALLOWANCE_CONFIRMATION_COOLDOWN_MS)
  }, [refreshAllowance])
  return useMemo(() => [cooldown, begin] as const, [begin, cooldown])
}
