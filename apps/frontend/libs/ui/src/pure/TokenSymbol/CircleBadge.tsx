import { ReactNode, useEffect, useRef, useState } from 'react'

import { t } from '@lingui/core/macro'
import styled from 'styled-components/macro'

import Popover from '../Popover'

const Badge = styled.span`
  display: inline-flex;
  margin-left: 4px;
  vertical-align: -2px;
  color: #2775ca;
  cursor: help;

  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
    border-radius: 50%;
  }
`

const Description = styled.span`
  display: block;
  max-width: 240px;
  margin-top: 4px;
  font-weight: 400;
  line-height: 1.4;
`

export function CircleBadge({ restricted }: { restricted: boolean }): ReactNode {
  const [show, setShow] = useState(false)
  const [standalone, setStandalone] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    // TokenSymbol also lives inside token-selection buttons. Reuse their focus
    // instead of nesting another focusable control inside a button or link.
    const parent = ref.current?.parentElement?.closest('button, a, [role="button"]')
    setStandalone(!parent)
    const open = (): void => setShow(true)
    const close = (): void => setShow(false)
    parent?.addEventListener('focus', open)
    parent?.addEventListener('blur', close)
    return () => {
      parent?.removeEventListener('focus', open)
      parent?.removeEventListener('blur', close)
    }
  }, [])

  useEffect(() => {
    if (!show) return
    const dismiss = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
        event.stopPropagation()
      } else if (event.target instanceof Node && ref.current?.contains(event.target)) return
      setShow(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss, true)
    }
  }, [show])
  const label = t`Official Circle token`
  const description = restricted
    ? t`Contract verified against Circle's registry. USYC requires an eligible, allowlisted wallet.`
    : t`Contract verified against Circle's registry.`

  return (
    <Popover
      inline
      show={show}
      placement="top"
      content={
        <span role="tooltip">
          <strong>{label}</strong>
          <Description>{description}</Description>
        </span>
      }
    >
      <Badge
        ref={ref}
        role={standalone ? 'button' : undefined}
        tabIndex={standalone ? 0 : undefined}
        aria-expanded={standalone ? show : undefined}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          setShow(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.stopPropagation()
          event.preventDefault()
          setShow(true)
        }}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" role="img" aria-label={`${label}. ${description}`}>
          <circle cx="8" cy="8" r="8" fill="currentColor" />
          <path
            d="m4.5 8 2.25 2.25 4.75-4.75"
            stroke="white"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Badge>
    </Popover>
  )
}
