#!/usr/bin/env node
/**
 * Build-time a11y gate: FAIL the build if a PUBLISHED blog post has a body image
 * with no alt text (Markdown `![](...)` or an `<img>` without a non-empty alt).
 *
 * Why a standalone scan, not a rehype throw: the Astro content-layer glob loader
 * ISOLATES per-entry render errors — it logs them but `astro build` / `astro check`
 * still EXIT 0, so a thrown rehype error does not fail CI (verified). This script
 * exits 1, and it is wired into the `build` npm script (which the deploy workflow
 * runs), so the gate is real. Drafts (`draft: true`) are skipped so work in progress
 * never blocks the build. Image syntax inside code fences / inline code is ignored.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const blogDir = resolve(root, 'src/content/blog')

function walk(dir) {
  let out = []
  for (const e of readdirSync(dir)) {
    if (e.startsWith('_')) continue // ignored by the content glob (drafts/partials)
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) out = out.concat(walk(p))
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}

// Remove fenced code blocks + inline code so example image syntax isn't flagged.
const stripCode = (md) =>
  md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')

const isDraft = (md) => {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return fm ? /^\s*draft:\s*true\s*$/im.test(fm[1]) : false
}

const offenders = []
for (const file of walk(blogDir)) {
  const raw = readFileSync(file, 'utf8')
  if (isDraft(raw)) continue
  const body = stripCode(raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, ''))

  // Markdown images: ![alt](...) — alt is group 1.
  for (const m of body.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) {
    if (m[1].trim() === '') offenders.push({ file, snippet: m[0].slice(0, 80) })
  }
  // Raw HTML images: <img ...> without a non-empty alt.
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const alt = m[0].match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i)
    const altVal = alt ? (alt[2] ?? alt[3] ?? '') : null
    if (altVal === null || altVal.trim() === '') offenders.push({ file, snippet: m[0].slice(0, 80) })
  }
}

if (offenders.length) {
  console.error(`check-blog-alt: ${offenders.length} published-post image(s) missing alt text:\n`)
  for (const o of offenders) console.error(`  ${relative(root, o.file)}   ${o.snippet}`)
  console.error('\nEvery image in a published post needs descriptive alt text: `![what it shows](...)`.')
  console.error('While drafting, set `draft: true` to skip this check.')
  process.exit(1)
}
console.log('check-blog-alt: OK — all published-post images have alt text')
