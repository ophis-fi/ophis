#!/usr/bin/env node
/**
 * Post-build gate: every FAQPage answer must appear verbatim in the page's own
 * visible text.
 *
 * That is Google's actual requirement for FAQ structured data, and it is the
 * single invariant worth asserting. The earlier version of this gate tried to
 * approximate it by pulling snake_case identifiers out of the markdown source
 * and checking they survived, which had two flaws: it also matched identifiers
 * that only ever appear in link TARGETS (never rendered, so legitimately absent
 * from the schema), and it only looked for flat `<slug>.md` sources, silently
 * skipping the nested `blog/topic/post.md` layout that content.config.ts
 * accepts. A gate that quietly covers less than it claims is the failure mode
 * this file exists to prevent, so it now compares schema against rendered
 * output and needs no knowledge of the source layout at all.
 *
 * Reads dist/, so it runs in postbuild next to check-csp-hashes.
 * Exit 0 = OK, 1 = drift.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname, join, relative } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

// DELIBERATELY does not import the generator's htmlToText from scripts/lib/.
// A verifier that shares the implementation it verifies cannot detect a bug in
// that implementation: both sides transform identically, the two strings still
// match, and the gate stays green while the real page disagrees with the schema.
// Proved by mutation - making the shared extractor strip underscores left this
// gate passing while pages showed `build_order` and schema said "buildorder".
// So visible text is recovered here by an independent walk, and the duplication
// is the point.
// DELIBERATELY does not import the generator's htmlToText from scripts/lib/.
// A verifier that shares the implementation it verifies cannot detect a bug in
// that implementation: both sides transform identically, the two strings still
// match, and the gate stays green while the real page disagrees with the
// schema. Proved by mutation - making a shared extractor strip underscores left
// this gate passing while pages showed `build_order` and schema said
// "buildorder". So the duplication is the point.
//
// The two implementations are held to ONE behavioural spec by
// scripts/test-html-text.mjs, which runs this function and htmlToText over the
// same case table and also asserts they agree. Independent code, shared
// contract: drift is a test failure, not a silent divergence.
//
// Scans the ORIGINAL string. An earlier version split on '<' first, which broke
// on a '<' inside a quoted attribute (the tag arrived as two fragments, neither
// with balanced quotes) and on comments containing an apostrophe.
const NAMED_REFS = {
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
const REFS = new RegExp(`&(?:#(\\d+)|#[xX]([0-9a-fA-F]+)|(${Object.keys(NAMED_REFS).join('|')}));`, 'g')
const BLOCKISH =
  /^\/?(?:p|br|div|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|pre|section|article|header|footer|h[1-6]|hr|figure|figcaption|dl|dt|dd)$/

const visibleTextOf = (html) => {
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    // Comments first: their contents may hold quotes and '>' that are not markup.
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close === -1 ? html.length : close + 3
      continue
    }

    let gt = -1
    for (let j = lt + 1, quote = null; j < html.length; j++) {
      const c = html[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        gt = j
        break
      }
    }
    if (gt === -1) break

    const tag = html.slice(lt + 1, gt)
    const closing = tag.startsWith('/')
    const name = (/^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1] ?? '').toLowerCase()

    if (!closing && (name === 'script' || name === 'style')) {
      const close = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(gt + 1))
      i = close ? gt + 1 + close.index + close[0].length : html.length
      continue
    }
    if (BLOCKISH.test(name)) out += ' '
    i = gt + 1
  }

  return out
    .replace(REFS, (_m, dec, hex, nm) =>
      dec !== undefined
        ? String.fromCodePoint(Number(dec))
        : hex !== undefined
          ? String.fromCodePoint(parseInt(hex, 16))
          : NAMED_REFS[nm],
    )
    .replace(/\s+/g, ' ')
    .trim()
}

export { visibleTextOf, NAMED_REFS }

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
// The whole dist tree, not just dist/blog: the canonical pages (/pricing,
// /security, /supported-chains), the /learn guides, and the home page carry
// FAQPage schema too, and Google's verbatim-visible-text requirement applies
// to every one of them equally.
const distRoot = resolve(root, 'dist')

// Importing this module must not run the gate: the conformance suite in
// scripts/test-html-text.mjs imports visibleTextOf to hold both extractors to
// one spec, and test:unit runs BEFORE astro build, when dist/ does not exist.
function main() {
  if (!existsSync(distRoot)) {
    console.error('check-faq-schema: dist/ missing - run the build first.')
    process.exit(1)
  }

  // Every index.html under dist/, at any depth, so nested pages are covered.
  const pagesUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return pagesUnder(p)
      return e.name === 'index.html' ? [p] : []
    })

  const failures = []
  let pagesWithFaq = 0
  let answersChecked = 0

  for (const page of pagesUnder(distRoot)) {
    const slug = relative(distRoot, dirname(page)) || '(index)'
    const html = readFileSync(page, 'utf8')

    let faq = null
    // Attribute-tolerant: a tag like <script id="x" type="application/ld+json">
    // must NOT silently drop the page from coverage (mutation-proved: the old
    // byte-exact pattern let a page leave the gate with exit 0).
    for (const m of html.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis,
    )) {
      let parsed
      try {
        parsed = JSON.parse(m[1])
      } catch {
        failures.push(`${slug}: a JSON-LD block does not parse as JSON`)
        continue
      }
      if (parsed?.['@type'] === 'FAQPage') faq = parsed
    }

    // Blog posts have a known shape: faqPageSchema() derives the schema from a
    // rendered "## FAQ" section, so heading and schema must exist together.
    // Non-blog pages (home FAQSection, /pricing, /security, /learn guides)
    // build schema and visible sections from the SAME frontmatter constants,
    // in varying markup (details/summary, question-h2s), so only the verbatim
    // rule below applies to them.
    const isBlog = slug === 'blog' || slug.startsWith('blog/')
    if (isBlog) {
      // The rendered article carries <h2 id="faq">; if it does, schema is expected.
      const hasFaqHeading = /<h2\b[^>]*\bid="faq"/i.test(html)
      if (hasFaqHeading && !faq) {
        failures.push(`${slug}: renders an FAQ heading but emits no FAQPage schema`)
        continue
      }
      if (faq && !hasFaqHeading) {
        failures.push(`${slug}: emits FAQPage schema but renders no FAQ heading`)
        continue
      }
    }
    if (!faq) continue
    pagesWithFaq++

    // Named references the extractors do not know are a genuine blind spot:
    // both sides would carry `&theta;` through identically, so the verbatim
    // comparison below cannot see that the browser shows θ instead. Scan the
    // FAQ region of the SOURCE, not the decoded text - the previous version of
    // this check scanned decoded text and so rejected a legitimate `&amp;copy;`
    // code span, whose visible text really is the string "&copy;".
    //
    // Remark decodes named references while producing rendered.html (probed:
    // `&theta; &spades; &oplus;` arrive as θ ♠ ⊕), so this should never fire on
    // markdown content. It exists for the day that stops being true.
    const faqRegion = (() => {
      const h2 = /<h2\b[^>]*\bid="faq"[^>]*>/i.exec(html)
      if (!h2) return ''
      const after = html.slice(h2.index + h2[0].length)
      const next = /<h2\b/i.exec(after)
      return next ? after.slice(0, next.index) : after
    })()
    const unsupported = [
      ...new Set(
        [...faqRegion.matchAll(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g)]
          .map((m) => m[1])
          .filter((name) => !(name in NAMED_REFS)),
      ),
    ]
    if (unsupported.length) {
      failures.push(
        `${slug}: FAQ HTML contains named references this extractor does not decode: ` +
          `${unsupported.map((n) => `&${n};`).join(', ')} ` +
          `(add them to NAMED in scripts/lib/html-text.mjs AND NAMED_REFS here)`,
      )
    }

    // Strip the JSON-LD itself before extracting visible text, or the schema
    // would trivially "appear" inside its own serialized copy.
    const visible = visibleTextOf(
      // Same attribute-tolerant pattern as the finder above: if the strip were
      // narrower, an attribute-carrying schema block would survive into the
      // "visible" text and trivially match its own serialization.
      html.replace(
        /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
        '',
      ),
    )

    for (const q of faq.mainEntity ?? []) {
      const question = (q.name ?? '').trim()
      const answer = (q.acceptedAnswer?.text ?? '').trim()
      if (!question || !answer) {
        failures.push(`${slug}: an FAQ entry has an empty question or answer`)
        continue
      }
      answersChecked++
      if (!visible.includes(question)) {
        failures.push(`${slug}: question not found in visible text: ${JSON.stringify(question.slice(0, 70))}`)
      }
      if (!visible.includes(answer)) {
        // Report the first point of divergence so the cause is obvious.
        let i = 0
        while (i < answer.length && visible.includes(answer.slice(0, i + 1))) i++
        failures.push(
          `${slug}: answer text diverges from the page at char ${i}: ` +
            `schema has ${JSON.stringify(answer.slice(Math.max(0, i - 30), i + 30))}`,
        )
      }
    }
  }

  if (failures.length) {
    console.error('check-faq-schema FAILED:\n')
    for (const f of failures) console.error(`  - ${f}`)
    console.error(
      '\nFAQPage text must reproduce the rendered answer (Google requirement). The\n' +
        'schema is built by faqPageSchema() in src/pages/blog/[...slug].astro from the\n' +
        "post's rendered HTML; fix that transform (or the post), not this gate.\n",
    )
    process.exit(1)
  }

  console.log(
    `check-faq-schema: OK - ${pagesWithFaq} page(s) with FAQPage, ` +
      `${answersChecked} answer(s) verbatim in the rendered page`,
  )

}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
