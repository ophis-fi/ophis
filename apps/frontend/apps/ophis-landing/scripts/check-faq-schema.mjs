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
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const distBlog = resolve(root, 'dist/blog')

if (!existsSync(distBlog)) {
  console.error('check-faq-schema: dist/blog missing - run the build first.')
  process.exit(1)
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

// Mirrors htmlToText() in src/pages/blog/[...slug].astro.
const htmlToText = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/td|\/th|\/blockquote)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()

// Every index.html under dist/blog, at any depth, so nested posts are covered.
const pagesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return pagesUnder(p)
    return e.name === 'index.html' ? [p] : []
  })

const failures = []
let pagesWithFaq = 0
let answersChecked = 0

for (const page of pagesUnder(distBlog)) {
  const slug = relative(distBlog, dirname(page)) || '(index)'
  const html = readFileSync(page, 'utf8')

  let faq = null
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let parsed
    try {
      parsed = JSON.parse(m[1])
    } catch {
      failures.push(`${slug}: a JSON-LD block does not parse as JSON`)
      continue
    }
    if (parsed?.['@type'] === 'FAQPage') faq = parsed
  }

  // The rendered article carries <h2 id="faq">; if it does, schema is expected.
  const hasFaqHeading = /<h2\b[^>]*\bid="faq"/i.test(html)
  if (hasFaqHeading && !faq) {
    failures.push(`${slug}: renders an FAQ heading but emits no FAQPage schema`)
    continue
  }
  if (!faq) continue
  if (!hasFaqHeading) {
    failures.push(`${slug}: emits FAQPage schema but renders no FAQ heading`)
    continue
  }
  pagesWithFaq++

  // Strip the JSON-LD itself before extracting visible text, or the schema
  // would trivially "appear" inside its own serialized copy.
  const visible = htmlToText(
    html.replace(/<script type="application\/ld\+json">.*?<\/script>/gs, ''),
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
