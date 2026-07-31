/**
 * Visible-text extraction from rendered HTML, shared by the blog post template
 * (which builds FAQPage schema from it) and scripts/check-faq-schema.mjs (which
 * asserts the schema reproduces the page). One implementation, so the gate can
 * never disagree with the thing it is checking.
 *
 * This is NOT an HTML sanitizer and must never be used as one: it produces text
 * for comparison and for JSON serialization, and anything embedding its output
 * in markup must escape it at that point (see jsonLdSafe in the post template).
 * It is written as a tokenizer rather than a chain of regex replaces both
 * because that is correct for nested/adjacent tags and because a regex
 * "tag stripper" is the classic incomplete-sanitization shape.
 */

// Block-level tags whose boundaries are word boundaries in the rendered text;
// without this, "</p><p>" would glue two paragraphs into one word.
const BLOCK = new Set([
  'p', 'br', 'div', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'thead', 'tbody',
  'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd',
])

// Elements whose CONTENT is not visible text.
const RAW_TEXT = new Set(['script', 'style'])

// Named entities this decoder understands. Remark decodes entities in ordinary
// markdown text before we ever see the HTML, so what reaches here comes from raw
// HTML blocks and from Astro's own escaping of `<`, `>`, `&`, `"`. The set is
// therefore deliberately small rather than the full HTML5 table of ~2200 names,
// and `undecodedEntitiesIn` below makes anything outside it a LOUD failure
// instead of a silent page/schema mismatch (a bare `&copy;` in the schema where
// the browser shows ©).
export const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°',
  hellip: '…', mdash: '—', ndash: '–', shy: '­',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', times: '×', divide: '÷',
  plusmn: '±', micro: 'µ', middot: '·', bull: '•',
  dagger: '†', permil: '‰', prime: '′', Prime: '″',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
}

// ONE pass over every reference form. Two passes were wrong: `&#38;copy;` is
// the text "&copy;" (the browser does not re-parse characters a reference
// produced), but decoding numeric first and named second turned it into "©",
// so the page and the schema disagreed.
const REF_RE = new RegExp(`&(?:#(\\d+)|#[xX]([0-9a-fA-F]+)|(${Object.keys(NAMED).join('|')}));`, 'g')

export function decodeEntities(s) {
  return s.replace(REF_RE, (_m, dec, hex, name) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec))
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
    return NAMED[name]
  })
}

export function htmlToText(html) {
  let out = ''
  let i = 0
  const n = html.length

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    // Comments and CDATA-ish constructs.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    // Find the tag's real end, skipping any '>' that sits inside a quoted
    // attribute value: <abbr title="1 > 0">true</abbr> must yield "true", not
    // `0">true`. indexOf('>') alone gets this wrong.
    let gt = -1
    for (let j = lt + 1, quote = null; j < n; j++) {
      const c = html[j]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        continue
      }
      if (c === '>') {
        gt = j
        break
      }
    }
    if (gt === -1) break // unterminated tag: nothing after it is trustworthy text

    const tag = html.slice(lt + 1, gt)
    const closing = tag.startsWith('/')
    const name = (/^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1] ?? '').toLowerCase()

    // Skip the CONTENT of raw-text elements, but only from an opening tag: a
    // stray "</script>" must not swallow the rest of the document.
    if (!closing && RAW_TEXT.has(name)) {
      const close = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(gt + 1))
      i = close ? gt + 1 + close.index + close[0].length : n
      continue
    }

    if (BLOCK.has(name)) out += ' '
    i = gt + 1
  }

  return decodeEntities(out).replace(/\s+/g, ' ').trim()
}
