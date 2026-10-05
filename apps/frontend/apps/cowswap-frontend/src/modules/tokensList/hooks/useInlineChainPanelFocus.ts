import { RefObject, useEffect } from 'react'

export function useInlineChainPanelFocus(root: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const panel = root.current
    if (!panel?.parentElement) return
    const trigger = document.activeElement
    // The token controls stay mounted so search and scroll survive Back.
    // Inert siblings also let the slab's existing Tab trap target this view.
    const siblings = Array.from(panel.parentElement.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== panel && !element.inert,
    )
    siblings.forEach((element) => {
      element.inert = true
    })
    panel.querySelector<HTMLElement>('button, input')?.focus()
    return () => {
      siblings.forEach((element) => {
        element.inert = false
      })
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [root])
}
