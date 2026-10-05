import { useCallback, useEffect, useState } from 'react'

export function useAssetSwapCooldown(): [boolean, () => void] {
  const [active, setActive] = useState(false)
  // Preserve the trade action's 500ms cooldown even when animations are off.
  useEffect(() => {
    if (!active) return
    const timeout = window.setTimeout(() => setActive(false), 500)
    return () => window.clearTimeout(timeout)
  }, [active])
  const start = useCallback(() => setActive(true), [])
  return [active, start]
}
