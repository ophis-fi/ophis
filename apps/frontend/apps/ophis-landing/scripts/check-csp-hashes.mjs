#!/usr/bin/env node
/**
 * Build-time CSP hash verifier.
 * Walks EVERY emitted dist/**\/*.html, computes SHA-256 of every EXECUTABLE
 * inline <script> block, and verifies each hash appears in public/_headers.
 * Exits 1 (fails CI) if any hash is missing — prevents silent CSP drift across
 * ALL routes (the landing plus blog/content pages), not just the home page.
 *
 * Non-executable data blocks (application/ld+json, importmap, speculationrules)
 * are skipped: they are not subject to script-src, so they need no hash. This is
 * what lets a blog post carry inline BlogPosting JSON-LD without a _headers edit.
 *
 * Run after `astro build`: node scripts/check-csp-hashes.mjs
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve, join, relative } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const distDir = resolve(root, 'dist')
const headers = readFileSync(resolve(root, 'public/_headers'), 'utf8')

function walkHtml(dir) {
  let out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) out = out.concat(walkHtml(p))
    else if (entry.endsWith('.html')) out.push(p)
  }
  return out
}

// PRECONDITION: input is OUR Astro build output. Do not reuse on untrusted HTML
// without re-validating that no <script> attribute can embed a literal ">".
//
// Linearity (no ReDoS): both opening and closing tags use [^>]* (linear, no
// nested star); [\s\S]*? is lazy (linear). The \b word boundaries around
// `script` stop `</scriptx>` from matching, so an inner script-end cannot be
// smuggled into the captured body.
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi
// Data blocks are parsed, not executed -> exempt from script-src -> skip.
const dataTypeRe = /type\s*=\s*["']?\s*(application\/(ld\+json|json)|importmap|speculationrules)\b/i
// External scripts (src=...) are governed by the source list, not a hash.
const srcRe = /\bsrc\s*=/i

const htmlFiles = walkHtml(distDir)
if (htmlFiles.length === 0) {
  console.error('check-csp-hashes: no dist/**/*.html found — check the build.')
  process.exit(1)
}

const seen = new Set()
let execCount = 0
let failed = false
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  let m
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1]
    const body = m[2]
    if (srcRe.test(attrs)) continue // external script
    if (dataTypeRe.test(attrs)) continue // non-executable data block
    if (!body.trim()) continue
    execCount++
    const hash = 'sha256-' + createHash('sha256').update(body).digest('base64')
    if (!headers.includes(`'${hash}'`) && !seen.has(hash)) {
      console.error(`check-csp-hashes: MISSING hash in _headers: '${hash}'  (${relative(root, file)})`)
      failed = true
    }
    seen.add(hash)
  }
}

if (execCount === 0) {
  console.error('check-csp-hashes: no executable inline scripts found across dist — check the build.')
  process.exit(1)
}

if (failed) {
  console.error('\nAdd the missing hash(es) to the script-src list in public/_headers.')
  process.exit(1)
}

console.log(
  `check-csp-hashes: OK — ${seen.size} distinct executable inline-script hash(es) verified across ${htmlFiles.length} page(s)`,
)
