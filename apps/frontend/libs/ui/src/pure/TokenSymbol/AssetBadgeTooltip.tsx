import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'

import { Info } from 'react-feather'
import styled from 'styled-components/macro'

import { AssetCheck } from './AssetCheck'

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

interface AssetBadgeTooltipProps {
  label: string
  description: string
  infoOnly?: boolean
}

const focusable = 'button, a, [role="button"]'

function describe(owner: Element, id: string): () => void {
  const ids = (): string[] => (owner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  owner.setAttribute('aria-describedby', [...ids(), id].join(' '))
  return () => {
    const remaining = ids().filter((value) => value !== id)
    if (remaining.length) owner.setAttribute('aria-describedby', remaining.join(' '))
    else owner.removeAttribute('aria-describedby')
  }
}

export function AssetBadgeTooltip({ label, description, infoOnly }: AssetBadgeTooltipProps): ReactNode {
  const [show, setShow] = useState(false)
  const [standalone, setStandalone] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const tooltipId = useId()
  const closeTimer = useRef<number | undefined>(undefined)
  const open = useCallback((): void => {
    window.clearTimeout(closeTimer.current)
    setShow(true)
  }, [])
  const leave = useCallback((): void => {
    if (ref.current?.closest(focusable)?.matches(':focus')) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setShow(false), 300)
  }, [])

  useEffect(() => {
    // TokenSymbol also lives inside token-selection buttons. Reuse their focus
    // instead of nesting another focusable control inside a button or link.
    const parent = ref.current?.parentElement?.closest(focusable)
    setStandalone(!parent)
    const close = (): void => setShow(false)
    parent?.addEventListener('focus', open)
    parent?.addEventListener('blur', close)
    return () => {
      window.clearTimeout(closeTimer.current)
      parent?.removeEventListener('focus', open)
      parent?.removeEventListener('blur', close)
    }
  }, [open])

  useEffect(() => {
    const owner = ref.current?.closest(focusable) ?? ref.current
    if (!show || !owner) return
    const removeDescription = describe(owner, tooltipId)
    const dismiss = (event: PointerEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
        event.stopPropagation()
      } else if (
        event.target instanceof Node &&
        (ref.current?.contains(event.target) || document.getElementById(tooltipId)?.contains(event.target))
      )
        return
      setShow(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss, true)
    return () => {
      removeDescription()
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss, true)
    }
  }, [show, tooltipId])
  return (
    <Popover
      inline
      show={show}
      placement="top"
      content={
        <span
          id={tooltipId}
          role="tooltip"
          onMouseEnter={open}
          onMouseLeave={leave}
          onClick={(event) => event.stopPropagation()}
        >
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
        onFocus={open}
        onBlur={() => setShow(false)}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          open()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.stopPropagation()
          event.preventDefault()
          open()
        }}
        onMouseEnter={open}
        onMouseLeave={leave}
      >
        {infoOnly ? (
          <Info size={14} color="var(--cow-color-text-secondary)" role="img" aria-label={`${label}. ${description}`} />
        ) : (
          <AssetCheck label={`${label}. ${description}`} />
        )}
      </Badge>
    </Popover>
  )
}
