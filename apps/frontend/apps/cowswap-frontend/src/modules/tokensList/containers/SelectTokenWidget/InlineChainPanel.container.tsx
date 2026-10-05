import { ReactNode, useRef } from 'react'

import { useInlineChainPanelFocus } from '../../hooks/useInlineChainPanelFocus'

interface InlineChainPanelProps {
  children: ReactNode
  title: string
  onClose(): void
}

export function InlineChainPanel({ children, title, onClose }: InlineChainPanelProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  useInlineChainPanelFocus(root)

  return (
    <div
      ref={root}
      className="swp-inline-network-list"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Back out one level without also closing the parent token picker.
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      {children}
    </div>
  )
}
