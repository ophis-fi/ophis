const LAST_RETRIED_ENTRY = 'ophis:lastRetriedChunkEntry'

export function shouldRetryChunkLoad(): boolean {
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src
  if (!navigator.onLine || !entry) return false

  try {
    // The entry filename identifies the build. Record it before reloading so a broken build cannot loop.
    if (sessionStorage.getItem(LAST_RETRIED_ENTRY) === entry) return false
    sessionStorage.setItem(LAST_RETRIED_ENTRY, entry)
    return true
  } catch {
    return false
  }
}
