import { RefObject, useEffect, useRef } from 'react'

const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]'

function focusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0,
  )
}

function cycleFocus(dialog: HTMLElement | null | undefined, event: KeyboardEvent): void {
  if (!dialog) return
  const elements = focusable(dialog)
  const first = elements[0]
  const last = elements[elements.length - 1]
  const edge = event.shiftKey ? first : last
  if (document.activeElement !== edge) return
  event.preventDefault()
  const next = event.shiftKey ? last : first
  next?.focus()
}

function keepPickerVisible(node: HTMLDivElement | null): void {
  if (!node?.classList.contains('swp-live')) return
  // The slab grows after opening. Bring its final size above the fold on
  // short phones before the token list takes keyboard focus.
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  node.style.setProperty('--swp-viewport-height', `${viewportHeight}px`)
  const height = parseFloat(getComputedStyle(node).height)
  const top = node.getBoundingClientRect().top
  if (top < 0 || top + height > viewportHeight) {
    node.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
}

export function useAssetSwapPickerFocus(
  root: RefObject<HTMLDivElement | null>,
  pick: number | null,
  close: () => void,
): void {
  const closeRef = useRef(close)
  const triggerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const node = root.current
    const rememberTrigger = (event: Event): void => {
      if (!(event.target instanceof Element)) return
      const trigger = event.target.closest<HTMLElement>('.swp-coin, .open-currency-select-button')
      if (trigger) triggerRef.current = trigger
    }
    node?.addEventListener('focusin', rememberTrigger)
    node?.addEventListener('pointerdown', rememberTrigger)
    return () => {
      node?.removeEventListener('focusin', rememberTrigger)
      node?.removeEventListener('pointerdown', rememberTrigger)
    }
  }, [root])
  useEffect(() => {
    closeRef.current = close
  }, [close])
  useEffect(() => {
    if (pick === null) return
    const trigger = triggerRef.current
    const keepVisible = (): void => keepPickerVisible(root.current)
    window.addEventListener('resize', keepVisible)
    window.visualViewport?.addEventListener('resize', keepVisible)
    const frame = requestAnimationFrame(() => {
      keepPickerVisible(root.current)
      const dialog = root.current?.querySelector<HTMLElement>('[role="dialog"]')
      if (dialog) (focusable(dialog)[0] ?? dialog).focus({ preventScroll: true })
    })
    // Import, consent and list-settings views replace the focused control.
    // Recover focus when that control disappears, without stealing it from
    // a user who deliberately focused something outside this inline picker.
    const observer = new MutationObserver(() => {
      const dialog = root.current?.querySelector<HTMLElement>('[role="dialog"]')
      if (dialog && (document.activeElement === document.body || document.activeElement === dialog)) {
        ;(focusable(dialog)[0] ?? dialog).focus({ preventScroll: true })
      }
    })
    if (root.current) observer.observe(root.current, { childList: true, subtree: true })
    const key = (event: KeyboardEvent): void => {
      // A nested network/import modal can own focus outside this inline picker.
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      } else if (event.key === 'Tab') {
        cycleFocus(root.current.querySelector<HTMLElement>('[role="dialog"]'), event)
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', keepVisible)
      window.visualViewport?.removeEventListener('resize', keepVisible)
      window.removeEventListener('keydown', key)
      // Closing restores keyboard focus to the coin that opened this slab.
      requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus()
      })
    }
  }, [root, pick])
}
