#!/usr/bin/env node
// Generates static/llms-full.txt: the whole docs corpus concatenated into one
// plain-text file for LLM context windows (llms.txt links to it, per the
// llms.txt convention's optional llms-full.txt companion). Runs before
// `docusaurus build` (see package.json "build"); the output lands in static/
// and is copied verbatim into the site root by the build. The file is
// build-generated and gitignored. Soft-fails (exit 0) so a generation hiccup
// can never block a docs deploy; the /llms-full.txt link 404s until the next
// good run instead.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = join(ROOT, 'docs')
const OUT = join(ROOT, 'static', 'llms-full.txt')
const SITE = 'https://docs.ophis.fi'
// Mirror the sidebar reading order; docs not listed here sort after, A→Z.
const ORDER = [
  'intro',
  'getting-started',
  'architecture',
  'fees',
  'affiliate',
  'comparison',
  'intent-api',
  'ai-agents',
  'widget',
  'partners',
  'audits',
  'status',
  'faq',
]

try {
  // The docs tree is flat (see docs/); extend to a recursive walk if that changes.
  const files = readdirSync(DOCS).filter((f) => ['.md', '.mdx'].includes(extname(f)))
  const entries = files.map((f) => {
    const raw = readFileSync(join(DOCS, f), 'utf8')
    let body = raw
    const fm = {}
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    if (m) {
      body = raw.slice(m[0].length)
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
        if (kv) fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
      }
    }
    const id = basename(f).replace(/\.(md|mdx)$/, '')
    const slug = fm.slug || (id === 'intro' || id === 'index' ? '/' : `/${id}`)
    const title = fm.title || (body.match(/^#\s+(.+)$/m) || [])[1] || id
    // Drop MDX import/export lines; keep the prose and code blocks verbatim.
    body = body
      .split('\n')
      .filter((l) => !/^(import|export)\s/.test(l))
      .join('\n')
      .trim()
    return { id, slug, title, body }
  })
  entries.sort((a, b) => {
    const ai = ORDER.indexOf(a.id)
    const bi = ORDER.indexOf(b.id)
    const ar = ai === -1 ? ORDER.length : ai
    const br = bi === -1 ? ORDER.length : bi
    return ar - br || a.id.localeCompare(b.id)
  })
  const head = `# Ophis Docs (full text)\n\n> The complete docs.ophis.fi corpus in one file, generated at build time for LLM context windows. Each section header carries the canonical per-page URL. Index: ${SITE}/llms.txt\n`
  const out = [
    head,
    ...entries.map(
      (e) => `\n---\n\n# ${e.title}\nURL: ${SITE}${e.slug === '/' ? '/' : `${e.slug}/`}\n\n${e.body}\n`,
    ),
  ].join('')
  mkdirSync(join(ROOT, 'static'), { recursive: true })
  writeFileSync(OUT, out)
  console.log(`llms-full.txt: ${entries.length} pages, ${out.length} bytes`)
} catch (err) {
  console.error('llms-full generation failed (non-blocking):', err?.message || err)
}
