/**
 * IntentInput — contenteditable single-line text input that renders
 * recognized entity ranges as inline chips with logos.
 *
 * Why contenteditable: the previous layered <input> + overlay approach
 * cannot align the input caret with overlay chips that have variable
 * widths (logos change the chip width). contenteditable lets the
 * browser handle caret/selection natively while we render mixed
 * text + chip nodes inline.
 *
 * Caret preservation across re-renders: because we rebuild the DOM
 * when entities arrive, we record the caret's offset in plain-text
 * terms before the rebuild and restore it after. Chips are non-editable
 * (`contenteditable=false`) so the caret jumps over them as a unit.
 *
 * Security note: DOM is constructed programmatically (createElement +
 * createTextNode) — never via innerHTML — so user input cannot inject
 * markup.
 */
import { ClipboardEvent, ForwardedRef, forwardRef, KeyboardEvent, ReactNode, useCallback, useEffect, useImperativeHandle, useRef } from 'react'

import styled from 'styled-components/macro'

import type { Entity, EntityType } from './types'
import { entityLogo } from './tokenAssets'

// Cosmic palette — chips sit on the dark indigo input surface, with
// type-specific accents in the brand's coral/magenta/indigo trio.
const CHIP_BG: Record<EntityType, string> = {
  sellToken: 'rgba(247, 147, 60, 0.16)',
  buyToken: 'rgba(217, 96, 181, 0.18)',
  amount: 'rgba(245, 239, 230, 0.10)',
  chain: 'rgba(122, 110, 224, 0.20)',
}

const CHIP_BORDER: Record<EntityType, string> = {
  sellToken: '#F2A63E',
  buyToken: '#D960B5',
  amount: 'rgba(245, 239, 230, 0.55)',
  chain: '#7A6EE0',
}

const CHIP_TEXT: Record<EntityType, string> = {
  sellToken: '#FFC57E',
  buyToken: '#FFB7E2',
  amount: '#F5EFE6',
  chain: '#C8BEFF',
}

const Wrap = styled.div`
  position: relative;
  width: 100%;
`

const Editor = styled.div`
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 18px;
  line-height: 32px;
  letter-spacing: 0.01em;
  width: 100%;
  min-height: 64px;
  padding: 16px 56px 16px 22px;
  border-radius: 18px;
  border: 1.5px solid rgba(245, 239, 230, 0.18);
  background: rgba(8, 4, 24, 0.55);
  color: #f5efe6;
  caret-color: #f2a63e;
  outline: none;
  white-space: pre-wrap;
  word-break: break-word;
  transition: border-color 160ms ease-out, box-shadow 160ms ease-out, background 160ms ease-out;
  overflow-wrap: break-word;

  &:hover {
    border-color: rgba(242, 166, 62, 0.55);
  }

  &:focus {
    border-color: #f2a63e;
    background: rgba(8, 4, 24, 0.78);
    box-shadow: 0 0 0 4px rgba(242, 166, 62, 0.18), 0 12px 32px rgba(0, 0, 0, 0.45);
  }

  &:empty::before {
    content: attr(data-placeholder);
    color: rgba(245, 239, 230, 0.42);
    pointer-events: none;
  }

  /* Mobile: tighter horizontal padding so the placeholder doesn't get
     truncated awkwardly on 360px screens. Keep font-size ≥16px to
     prevent iOS auto-zoom on focus. */
  @media (max-width: 600px) {
    font-size: 17px;
    line-height: 28px;
    min-height: 56px;
    padding: 14px 44px 14px 16px;
    border-radius: 14px;
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
  border: 2px solid rgba(242, 166, 62, 0.25);
  border-top-color: #f2a63e;
  animation: spin 700ms linear infinite;
  pointer-events: none;
  @media (max-width: 600px) {
    right: 14px;
    width: 16px;
    height: 16px;
  }
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
}

interface Segment {
  text: string
  entity?: Entity
}

// Word-character regex for entity-range anchoring.
const WORD_RE = /[a-zA-Z0-9._-]/

/**
 * Anchor the entity to the WORD that contains the LLM's range — not
 * to the nearest word boundary in either direction, which can bridge
 * across an adjacent space when the LLM's offset is off-by-one and
 * sits on a separator.
 *
 * Strategy: pick a "core" character within the LLM's range that's a
 * word-character; from that core, walk both sides while word-char.
 * The resulting span is the single word containing the core. If no
 * word-char exists in the range (LLM landed on a separator only),
 * scan a few chars right / left for the closest word-char.
 *
 * The expanded slice is accepted only if it contains the LLM's `raw`
 * substring (case-insensitive), or vice versa, ensuring we never
 * mis-anchor onto an unrelated word.
 */
function expandRange(text: string, e: Entity): { start: number; end: number } {
  const lo = Math.max(0, Math.min(e.start, text.length))
  const hi = Math.max(lo, Math.min(e.end, text.length))
  const fallback = { start: lo, end: hi }

  // Find a word-char anchor inside the range; else look just outside.
  let core = -1
  for (let i = lo; i < hi; i++) {
    if (WORD_RE.test(text[i])) {
      core = i
      break
    }
  }
  if (core === -1) {
    for (let i = hi; i < text.length && i < hi + 4; i++) {
      if (WORD_RE.test(text[i])) {
        core = i
        break
      }
    }
  }
  if (core === -1) {
    for (let i = lo - 1; i >= 0 && i >= lo - 4; i--) {
      if (WORD_RE.test(text[i])) {
        core = i
        break
      }
    }
  }
  if (core === -1) return fallback

  let s = core
  let t = core + 1
  while (s > 0 && WORD_RE.test(text[s - 1])) s--
  while (t < text.length && WORD_RE.test(text[t])) t++

  const expanded = text.slice(s, t).toLowerCase()
  const raw = e.raw.toLowerCase().trim()
  if (expanded.length === 0 || raw.length === 0) return fallback
  if (expanded.includes(raw) || raw.includes(expanded)) return { start: s, end: t }
  return fallback
}

function buildSegments(text: string, entities: Entity[]): Segment[] {
  if (entities.length === 0) return [{ text }]
  const sorted = [...entities]
    .map((e) => ({ entity: e, ...expandRange(text, e) }))
    .sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let cursor = 0
  for (const r of sorted) {
    const s = Math.max(r.start, cursor)
    const t = Math.max(r.end, s)
    if (s > cursor) out.push({ text: text.slice(cursor, s) })
    if (t > s) out.push({ text: text.slice(s, t), entity: r.entity })
    cursor = t
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) })
  return out
}

function getCaretPlainOffset(root: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  if (!root.contains(range.endContainer)) return 0
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.endContainer, range.endOffset)
  return pre.toString().length
}

function setCaretPlainOffset(root: HTMLElement, target: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  let remaining = target
  let placed = false

  function visit(node: Node): boolean {
    if (placed) return true
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (remaining <= len) {
        range.setStart(node, remaining)
        range.collapse(true)
        placed = true
        return true
      }
      remaining -= len
      return false
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.dataset.entityChip === 'true') {
        const chipLen = (el.dataset.chipText ?? '').length
        if (remaining <= chipLen) {
          range.setStartAfter(el)
          range.collapse(true)
          placed = true
          return true
        }
        remaining -= chipLen
        return false
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        if (visit(node.childNodes[i])) return true
      }
    }
    return false
  }

  visit(root)
  if (!placed) {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

function buildChip(seg: Segment & { entity: Entity }, idx: number): HTMLSpanElement {
  const e = seg.entity
  const span = document.createElement('span')
  span.className = 'entity-chip'
  span.dataset.entityChip = 'true'
  span.dataset.chipText = seg.text
  span.dataset.entityType = e.type
  span.contentEditable = 'false'
  span.style.setProperty('--chip-bg', CHIP_BG[e.type])
  span.style.setProperty('--chip-border', CHIP_BORDER[e.type])
  span.style.setProperty('--chip-fg', CHIP_TEXT[e.type])
  // Stagger index drives the streaming-in animation delay.
  span.style.setProperty('--idx', String(idx))

  const logo = entityLogo(e.type, e.value)
  if (logo) {
    const img = document.createElement('img')
    img.src = logo
    img.alt = ''
    img.loading = 'lazy'
    img.className = 'chip-logo'
    span.appendChild(img)
  }
  const text = document.createElement('span')
  text.className = 'chip-text'
  text.appendChild(document.createTextNode(seg.text))
  span.appendChild(text)
  return span
}

function buildFragment(value: string, entities: Entity[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  let chipIdx = 0
  for (const seg of buildSegments(value, entities)) {
    if (seg.entity) {
      frag.appendChild(buildChip(seg as Segment & { entity: Entity }, chipIdx))
      chipIdx++
    } else if (seg.text) {
      frag.appendChild(document.createTextNode(seg.text))
    }
  }
  return frag
}

function readPlainTextValue(el: HTMLElement): string {
  let out = ''
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as HTMLElement
      if (e.dataset.entityChip === 'true') {
        out += e.dataset.chipText ?? ''
        return
      }
      if (e.tagName === 'BR') {
        out += '\n'
        return
      }
      for (let i = 0; i < e.childNodes.length; i++) visit(e.childNodes[i])
    }
  }
  visit(el)
  return out
}

const ChipStyles = styled.div`
  /* Text-stream chip animation: each chip cascades in with a small
     stagger so the entities feel "discovered" as the model returns
     them. The --idx variable is set on each chip in buildChip(). */
  & .entity-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px 2px 6px;
    margin: 0 1px;
    border: 1px solid var(--chip-border);
    background: var(--chip-bg);
    border-radius: 999px;
    color: var(--chip-fg);
    font-weight: 600;
    font-size: 16px;
    line-height: 24px;
    vertical-align: baseline;
    user-select: none;
    animation: chip-stream-in 240ms ease-out backwards;
    animation-delay: calc(var(--idx, 0) * 70ms);
  }
  & .entity-chip .chip-logo {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.85);
    display: block;
  }
  @media (max-width: 600px) {
    & .entity-chip {
      font-size: 15px;
      line-height: 22px;
      padding: 1px 9px 1px 5px;
      gap: 5px;
    }
    & .entity-chip .chip-logo {
      width: 16px;
      height: 16px;
    }
  }
  @keyframes chip-stream-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`

export interface IntentInputHandle {
  focus: () => void
}

export const IntentInput = forwardRef(function IntentInput(
  { value, onChange, onSubmit, entities, pending, placeholder }: Props,
  ref: ForwardedRef<IntentInputHandle>,
): ReactNode {
  const editorRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
  }))

  useEffect(() => {
    const el = editorRef.current
    if (!el) return

    const focused = document.activeElement === el
    const caret = focused ? getCaretPlainOffset(el) : null

    // Skip the rebuild when our DOM already represents this state
    // (avoids fighting the user's own typing on every keystroke).
    const currentPlain = readPlainTextValue(el)
    const currentEntityCount = el.querySelectorAll('[data-entity-chip="true"]').length
    if (currentPlain === value && currentEntityCount === entities.length) return

    el.replaceChildren(buildFragment(value, entities))

    if (focused && caret !== null) {
      setCaretPlainOffset(el, caret)
    }
  }, [value, entities])

  const handleInput = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const next = readPlainTextValue(el).replace(/\n+/g, ' ')
    if (next !== value) onChange(next)
  }, [onChange, value])

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (onSubmit) onSubmit()
      }
    },
    [onSubmit],
  )

  // Sanitize paste: strip rich-text HTML and only insert the clipboard's
  // plain-text payload at the caret. Default contenteditable behavior
  // accepts <img>/<style>/styled spans, including markup that could
  // carry `data-entity-chip="true"` to fool the rebuild-skip heuristic.
  // Self-XSS scope only, but trivially fixable here.
  const handlePaste = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' ')
    if (!text) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    range.insertNode(document.createTextNode(text))
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    const el = editorRef.current
    if (!el) return
    const next = readPlainTextValue(el).replace(/\n+/g, ' ')
    if (next !== value) onChange(next)
  }, [onChange, value])

  return (
    <Wrap>
      <ChipStyles>
        <Editor
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          aria-label="Describe the swap you want to make"
          aria-multiline="false"
          data-placeholder={placeholder}
          onInput={handleInput}
          onKeyDown={handleKey}
          onPaste={handlePaste}
        />
      </ChipStyles>
      {pending && <Spinner />}
    </Wrap>
  )
})
