import { useEffect, useState } from 'react'

const OTC_AGE_REFRESH_INTERVAL_MS = 60_000

/** Keeps relative OTC timestamps moving while a page remains mounted. */
export function useOtcNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), OTC_AGE_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])

  return nowMs
}
