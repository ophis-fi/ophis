import { CHAIN_ID } from './config'

export function reportEmbeddedLayout(): void {
  if (window.parent === window) return
  const main = document.querySelector('main')
  if (!main) return
  let scheduled = false
  const report = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const dialog = document.querySelector('dialog[open]')
      window.parent.postMessage({
        type: 'ophis:private-layout-v1',
        chainId: CHAIN_ID,
        // A modal must fit the host viewport, rather than the full expanded wallet page.
        height: Math.ceil(dialog ? Math.min(dialog.scrollHeight + 40, window.parent.innerHeight - 80)
          : main.getBoundingClientRect().height),
        busy: document.documentElement.dataset.busy === 'true',
      }, location.origin)
    })
  }
  new ResizeObserver(report).observe(main)
  new MutationObserver(report).observe(document.documentElement, { attributes: true, childList: true, subtree: true })
  window.addEventListener('resize', report)
  report()
}
