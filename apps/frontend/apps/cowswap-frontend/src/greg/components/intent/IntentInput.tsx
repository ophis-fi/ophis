/**
 * Layered text input that highlights extracted entity character ranges
 * with a translucent background colour while the user types.
 *
 * Implementation pattern: a regular <input> for keystrokes/IME (correct
 * caret behavior, selection, accessibility) plus an absolutely positioned
 * underlay <div> that renders the same string with <mark> spans behind
 * each entity range. Both layers share font, padding, and width so the
 * highlight aligns with the visible characters; the input text itself
 * stays opaque on top.
 */
import { ChangeEvent, ForwardedRef, KeyboardEvent, ReactNode, forwardRef, useMemo } from 'react'

import styled from 'styled-components/macro'

import type { Entity, EntityType } from './types'

const HIGHLIGHT_BG: Record<EntityType, string> = {
  sellToken: 'rgba(230, 106, 85, 0.22)',
  buyToken: 'rgba(199, 61, 108, 0.22)',
  amount: 'rgba(0, 133, 87, 0.22)',
  chain: 'rgba(110, 115, 117, 0.22)',
}

const SHARED_TEXT_STYLES = `
  font-family: var(--cow-font-family-primary);
  font-size: 18px;
  line-height: 28px;
  letter-spacing: 0.005em;
  padding: 18px 56px 18px 22px;
  white-space: pre;
`

const Wrap = styled.div`
  position: relative;
  width: 100%;
`

const Underlay = styled.div`
  ${SHARED_TEXT_STYLES}
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: transparent;
  border-radius: 16px;
  overflow: hidden;
  /* The input scrolls horizontally on overflow; we don't replicate that
     here. The visible text is the input's; the underlay only colours the
     ranges that are in view. Long inputs that overflow will lose the
     highlight on offscreen text — acceptable for V1. */
`

const Mark = styled.span<{ $type: EntityType }>`
  background: ${({ $type }) => HIGHLIGHT_BG[$type]};
  border-radius: 4px;
  padding: 2px 0;
  margin: -2px 0;
`

const InputEl = styled.input`
  ${SHARED_TEXT_STYLES}
  position: relative;
  width: 100%;
  background: transparent;
  border: 1.5px solid var(--greg-color-stroke-strong, #c1c4c6);
  border-radius: 16px;
  color: var(--greg-color-text-primary, #1f2224);
  outline: none;
  transition: border-color 140ms ease-out, box-shadow 140ms ease-out;

  &::placeholder {
    color: var(--greg-color-text-tertiary, #898d8f);
  }

  &:hover {
    border-color: #e66a55;
  }

  &:focus {
    border-color: #e66a55;
    box-shadow: 0 0 0 3px rgba(230, 106, 85, 0.18);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`

const Spinner = styled.div`
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(230, 106, 85, 0.25);
  border-top-color: #e66a55;
  animation: spin 700ms linear infinite;

  @keyframes spin {
    to {
      transform: translateY(-50%) rotate(360deg);
    }
  }
`

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  entities: Entity[]
  pending: boolean
  placeholder?: string
  disabled?: boolean
}

function buildSegments(text: string, entities: Entity[]): Array<{ text: string; type?: EntityType }> {
  if (entities.length === 0) return [{ text }]

  // Normalize: sort by start, drop overlaps. The function only emits
  // valid non-overlapping ranges, but be defensive against drift.
  const sorted = [...entities].sort((a, b) => a.start - b.start)
  const out: Array<{ text: string; type?: EntityType }> = []
  let cursor = 0

  for (const e of sorted) {
    const s = Math.max(e.start, cursor)
    const t = Math.max(e.end, s)
    if (s > cursor) out.push({ text: text.slice(cursor, s) })
    if (t > s) out.push({ text: text.slice(s, t), type: e.type })
    cursor = t
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) })
  return out
}

export const IntentInput = forwardRef(function IntentInput(
  { value, onChange, onSubmit, entities, pending, placeholder, disabled }: Props,
  ref: ForwardedRef<HTMLInputElement>,
): ReactNode {
  const segments = useMemo(() => buildSegments(value, entities), [value, entities])

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault()
      onSubmit()
    }
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange(e.target.value)
  }

  return (
    <Wrap>
      <Underlay aria-hidden>
        {segments.map((seg, i) =>
          seg.type ? (
            <Mark key={i} $type={seg.type}>
              {seg.text}
            </Mark>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </Underlay>
      <InputEl
        ref={ref}
        type="text"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Describe the swap you want to make"
      />
      {pending && <Spinner aria-label="Parsing" />}
    </Wrap>
  )
})
