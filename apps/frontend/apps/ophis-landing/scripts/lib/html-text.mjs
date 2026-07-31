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

export function decodeEntities(s) {
  return (
    s
      .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      // Last: an entity's own '&' must not be re-decoded into another entity.
      .replace(/&amp;/g, '&')
  )
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
    const gt = html.indexOf('>', lt)
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
