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

import { OphisGlobeLoader } from '../OphisGlobeLoader'

import type { Entity, EntityType } from './types'
import { entityLogo } from './tokenAssets'

// Paper-card aesthetic per Clement's V3 design call (2026-05-10):
// the search box is a warm off-white card on the dark cosmic landing.
// Near-black ink, monospace label accents on chips.
const PAPER = '#FAF6EE'
const INK = '#0F0E0B'
const INK_MUTED = 'rgba(15, 14, 11, 0.55)'
const HAIRLINE = 'rgba(15, 14, 11, 0.10)'

const CHIP_BG: Record<EntityType, string> = {
  sellToken: 'rgba(204, 95, 38, 0.10)', // warm coral on paper
  buyToken: 'rgba(150, 41, 105, 0.10)', // muted magenta on paper
  amount: 'rgba(15, 14, 11, 0.06)', // grey on paper
  chain: 'rgba(53, 41, 132, 0.10)', // indigo on paper
}

const CHIP_BORDER: Record<EntityType, string> = {
  sellToken: 'rgba(204, 95, 38, 0.55)',
  buyToken: 'rgba(150, 41, 105, 0.55)',
  amount: 'rgba(15, 14, 11, 0.18)',
  chain: 'rgba(53, 41, 132, 0.55)',
}

const CHIP_TEXT: Record<EntityType, string> = {
  sellToken: '#7A3811',
  buyToken: '#5B1542',
  amount: INK,
  chain: '#2C2070',
}

const Wrap = styled.div`
  position: relative;
  width: 100%;
`

const Card = styled.div`
  position: relative;
  width: 100%;
  background: ${PAPER};
  border-radius: 22px;
  padding: 14px 16px 16px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.4) inset,
    0 0 0 1px ${HAIRLINE},
    0 18px 40px rgba(0, 0, 0, 0.32),
    0 4px 10px rgba(0, 0, 0, 0.18);
  transition: box-shadow 200ms ease-out;

  &:focus-within {
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.4) inset,
      0 0 0 1px rgba(15, 14, 11, 0.16),
      0 0 0 4px rgba(242, 166, 62, 0.20),
      0 18px 40px rgba(0, 0, 0, 0.36),
      0 4px 10px rgba(0, 0, 0, 0.22);
  }
`

const Eyebrow = styled.span`
  display: block;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: ${INK_MUTED};
  margin: 0 4px 8px;
`

const Editor = styled.div`
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-size: 18px;
  line-height: 32px;
  letter-spacing: 0.005em;
  width: 100%;
  min-height: 36px;
  padding: 6px 80px 6px 4px;
  background: transparent;
  color: ${INK};
  caret-color: ${INK};
  outline: none;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;

  &:empty::before {
    content: attr(data-placeholder);
    color: rgba(15, 14, 11, 0.36);
    pointer-events: none;
  }
`

const LoaderSlot = styled.div`
  position: absolute;
  right: 14px;
  top: 12px;
  pointer-events: none;
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
  /* The label fragment beside the symbol is rendered with the brand
     monospace, so the chip reads as "tagged data" rather than UI copy. */
  & .entity-chip .chip-text {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    font-size: 13px;
    letter-spacing: 0.01em;
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
    // Manually fire onInput-equivalent: read the canonical plain text.
    const el = editorRef.current
    if (!el) return
    const next = readPlainTextValue(el).replace(/\n+/g, ' ')
    if (next !== value) onChange(next)
  }, [onChange, value])

  return (
    <Card>
      <Eyebrow>Describe your swap</Eyebrow>
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
      {pending && (
        <LoaderSlot>
          <OphisGlobeLoader size={56} ariaLabel="Parsing intent" />
        </LoaderSlot>
      )}
    </Card>
  )
})
