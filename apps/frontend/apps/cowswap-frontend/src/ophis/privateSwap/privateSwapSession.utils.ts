// Capture at document boot: private mode always enters through a fresh navigation.
export const PRIVATE_SWAP_DOCUMENT =
  typeof window !== 'undefined' && /^\/private-swap\/(?:index\.html)?$/.test(window.location.pathname)

export function privateSwapUrl(enabled: boolean): string {
  const url = new URL(window.location.href)
  url.pathname = enabled ? '/private-swap/' : '/'
  url.searchParams.delete('privateSwapDesign')
  if (!url.hash) url.hash = '#/1/swap/_/_'
  return url.href
}
