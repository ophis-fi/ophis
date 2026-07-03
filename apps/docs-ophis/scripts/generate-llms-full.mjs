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
    // Drop TOP-LEVEL MDX import/export statements only. Lines inside fenced
    // code blocks are kept verbatim (code examples legitimately start with
    // import/export), and a multi-line `export const x = {...}` block is
    // skipped in full via brace balancing rather than leaving dangling text.
    const kept = []
    let inFence = false
    let skipDepth = 0
    let inHead = false
    let inComment = false
    for (const line of body.split('\n')) {
      if (/^(```|~~~)/.test(line.trimStart())) {
        inFence = !inFence
        kept.push(line)
        continue
      }
      if (inFence) {
        kept.push(line)
        continue
      }
      // Top-level MDX <Head>...</Head> blocks are per-page schema wiring
      // (JSON-LD via Docusaurus Head), not content — drop them whole so the
      // plain-text corpus carries no JSX wrappers or dangling identifiers.
      if (inHead) {
        if (line.includes('</Head>')) inHead = false
        continue
      }
      if (/^<Head[\s>]/.test(line.trimStart()) || line.trimStart() === '<Head>') {
        if (!line.includes('</Head>')) inHead = true
        continue
      }
      // Top-level MDX JSX comments ({/* ... */}, possibly multi-line) are
      // implementation notes for the schema plumbing, not content.
      if (inComment) {
        if (line.includes('*/}')) inComment = false
        continue
      }
      if (line.trimStart().startsWith('{/*')) {
        if (!line.includes('*/}')) inComment = true
        continue
      }
      if (skipDepth > 0) {
        skipDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
        if (skipDepth < 0) skipDepth = 0
        continue
      }
      if (/^import\s/.test(line)) continue
      if (/^export\s/.test(line)) {
        const depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
        if (depth > 0) skipDepth = depth
        continue
      }
      kept.push(line)
    }
    body = kept.join('\n').trim()
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
    // Slashless non-root URLs: must match the Docusaurus sitemap + existing
    // docs links exactly (one canonical URL variant for answer engines).
    ...entries.map(
      (e) => `\n---\n\n# ${e.title}\nURL: ${SITE}${e.slug === '/' ? '/' : e.slug}\n\n${e.body}\n`,
    ),
  ].join('')
  mkdirSync(join(ROOT, 'static'), { recursive: true })
  writeFileSync(OUT, out)
  console.log(`llms-full.txt: ${entries.length} pages, ${out.length} bytes`)
} catch (err) {
  console.error('llms-full generation failed (non-blocking):', err?.message || err)
}
