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
        height: Math.ceil(Math.max(main.getBoundingClientRect().height, (dialog?.scrollHeight || 0) + 40)),
        busy: document.documentElement.dataset.busy === 'true',
      }, location.origin)
    })
  }
  new ResizeObserver(report).observe(main)
  new MutationObserver(report).observe(document.documentElement, { attributes: true, childList: true, subtree: true })
  report()
}
