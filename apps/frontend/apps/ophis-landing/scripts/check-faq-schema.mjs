#!/usr/bin/env node
/**
 * Post-build gate: the FAQPage JSON-LD must match the visible answer text.
 *
 * Google requires FAQ structured data to reproduce what is on the page. The
 * schema is derived from each post's markdown by stripMd() in
 * src/pages/blog/[...slug].astro, and that transform has been wrong twice:
 *
 *   1. it stripped `_` wholesale, so `build_order` shipped as "buildorder" --
 *      a tool name that does not exist, in agent-facing copy;
 *   2. the first narrowing then missed `__strong__`, leaving the literal
 *      markers in the schema while the page rendered them away.
 *
 * Both were caught by review rather than by CI, so this asserts the OUTPUT
 * instead of the regex. Two checks per post:
 *
 *   A. every snake_case identifier in the post's markdown FAQ survives intact
 *      in the schema (catches mangling);
 *   B. no markdown markers leak into the schema (catches under-stripping):
 *      no backticks, no `*`, and no paired emphasis-shaped underscore runs.
 *
 * Reads dist/, so it runs in postbuild next to check-csp-hashes. Exit 0 = OK,
 * 1 = drift.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const dist = resolve(root, 'dist/blog')
const blogSrc = resolve(root, 'src/content/blog')

if (!existsSync(dist)) {
  console.error('check-faq-schema: dist/blog missing - run the build first.')
  process.exit(1)
}

const failures = []

// The FAQ section of a post's markdown, or '' when it has none.
const faqSectionOf = (md) => {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+FAQ\s*$/i.test(l))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s+/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

const faqPageOf = (html) => {
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let parsed
    try {
      parsed = JSON.parse(m[1])
    } catch {
      failures.push('a JSON-LD block does not parse as JSON')
      continue
    }
    if (parsed?.['@type'] === 'FAQPage') return parsed
  }
  return null
}

let postsChecked = 0
let identifiersChecked = 0

for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const slug = entry.name
  const htmlPath = join(dist, slug, 'index.html')
  if (!existsSync(htmlPath)) continue

  const mdPath = join(blogSrc, `${slug}.md`)
  if (!existsSync(mdPath)) continue // nested/renamed sources are out of scope
  const faqMd = faqSectionOf(readFileSync(mdPath, 'utf8'))
  const faq = faqPageOf(readFileSync(htmlPath, 'utf8'))

  if (!faqMd) {
    if (faq) failures.push(`${slug}: emits FAQPage but its markdown has no "## FAQ" section`)
    continue
  }
  if (!faq) {
    failures.push(`${slug}: has a "## FAQ" section but emits no FAQPage schema`)
    continue
  }
  postsChecked++

  const schemaText = faq.mainEntity
    .map((q) => `${q.name}\n${q.acceptedAnswer?.text ?? ''}`)
    .join('\n')

  // A. snake_case identifiers must survive. Sourced from the markdown so the
  // gate needs no hand-maintained list of tool names.
  const identifiers = new Set(faqMd.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])
  for (const id of identifiers) {
    identifiersChecked++
    if (!schemaText.includes(id)) {
      const mangled = id.replace(/_/g, '')
      const hint = schemaText.includes(mangled) ? ` (found "${mangled}" - underscores were stripped)` : ''
      failures.push(`${slug}: FAQ schema lost the identifier "${id}"${hint}`)
    }
  }

  // B. markdown markers must not leak through.
  if (schemaText.includes('`')) failures.push(`${slug}: FAQ schema contains a backtick`)
  if (schemaText.includes('*')) failures.push(`${slug}: FAQ schema contains an asterisk`)
  const leftoverEmphasis = schemaText.match(/(?<!\w)(_{1,3})(?=[^\s_])[\s\S]*?[^\s_]\1(?!\w)/g)
  if (leftoverEmphasis) {
    failures.push(
      `${slug}: FAQ schema contains unstripped underscore emphasis: ${leftoverEmphasis
        .slice(0, 3)
        .map((s) => JSON.stringify(s.slice(0, 40)))
        .join(', ')}`,
    )
  }
}

if (failures.length) {
  console.error('check-faq-schema FAILED:\n')
  for (const f of failures) console.error(`  - ${f}`)
  console.error(
    '\nThe FAQPage JSON-LD is derived from the post markdown by stripMd() in\n' +
      'src/pages/blog/[...slug].astro. Fix that transform (or the post), not this gate.\n',
  )
  process.exit(1)
}

console.log(
  `check-faq-schema: OK - ${postsChecked} post(s) with an FAQ, ` +
    `${identifiersChecked} snake_case identifier(s) intact, no markdown leaked`,
)
