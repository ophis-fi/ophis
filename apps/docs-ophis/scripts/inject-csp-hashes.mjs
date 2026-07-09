#!/usr/bin/env node
/**
 * Build-time CSP hash INJECTOR for docs.ophis.fi.
 *
 * Runs after `docusaurus build` (wired into the `build` npm script). Walks every
 * emitted build/**\/*.html, computes the SHA-256 of every EXECUTABLE inline
 * <script> block, and rewrites the DEPLOYED build/_headers so the CSP script-src
 * lists those hashes instead of 'unsafe-inline'. Browsers ignore 'unsafe-inline'
 * when a hash (or nonce) is present (CSP2+), so this hardens the docs CSP
 * without a hand-maintained hash list that would drift on every Docusaurus bump.
 *
 * The inline scripts covered are the Docusaurus theme bootstrap, the gtag
 * consent snippet, and the search/banner-insert bootstrap. JSON-LD / importmap /
 * speculationrules blocks are parsed, not executed (exempt from script-src), so
 * they are skipped.
 *
 * Fail-open by design: the SOURCE static/_headers keeps 'unsafe-inline', so if
 * this step is ever skipped the deployed site still loads under the (weaker)
 * unsafe-inline policy rather than breaking. Idempotent: re-running strips any
 * previously injected hashes before recomputing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve, join, relative } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const buildDir = resolve(root, 'build')
const headersPath = resolve(buildDir, '_headers')

// Read _headers now and reuse the contents. Reading once (instead of an
// existsSync pre-check followed by a later read/write) avoids a check-then-use
// file race (CodeQL js/toctou-race): a missing file surfaces as an ENOENT on
// this read with the same operator-facing message.
let headersSource
try {
  headersSource = readFileSync(headersPath, 'utf8')
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(
      `inject-csp-hashes: ${relative(root, headersPath)} not found — run docusaurus build first.`,
    )
    process.exit(1)
  }
  throw err
}

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

// PRECONDITION: our own Docusaurus build output. Linear (no ReDoS): both tags
// use [^>]* (no nested star) and the body is lazy [\s\S]*?; the \b word
// boundaries stop `</scriptx>` from closing the match early.
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi
// Data blocks are parsed, not executed -> exempt from script-src -> skip.
const dataTypeRe = /type\s*=\s*["']?\s*(application\/(ld\+json|json)|importmap|speculationrules)\b/i
// External scripts (src=...) are governed by the source list, not a hash.
const srcRe = /\bsrc\s*=/i

const htmlFiles = walkHtml(buildDir)
if (htmlFiles.length === 0) {
  console.error('inject-csp-hashes: no build/**/*.html found — check the build.')
  process.exit(1)
}

const hashes = new Set()
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  let m
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1]
    const body = m[2]
    if (srcRe.test(attrs)) continue // external script
    if (dataTypeRe.test(attrs)) continue // non-executable data block
    if (!body.trim()) continue
    hashes.add('sha256-' + createHash('sha256').update(body).digest('base64'))
  }
}

if (hashes.size === 0) {
  console.error(
    'inject-csp-hashes: no executable inline scripts found across build — check the build.',
  )
  process.exit(1)
}

const hashTokens = [...hashes].sort().map((h) => `'${h}'`)

let replaced = 0
const headers = headersSource.replace(
  /^(\s*Content-Security-Policy:\s*)(.+)$/gim,
  (_line, prefix, value) => {
    const directives = value
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
    const out = directives.map((d) => {
      const parts = d.split(/\s+/)
      if (parts[0] !== 'script-src') return d
      // Keep every existing token except 'unsafe-inline' and any prior sha
      // hash, then append the freshly computed hashes. Idempotent.
      const kept = parts.filter(
        (t) => t !== "'unsafe-inline'" && !/^'sha(256|384|512)-/.test(t),
      )
      replaced++
      return [...kept, ...hashTokens].join(' ')
    })
    return prefix + out.join('; ')
  },
)

if (replaced === 0) {
  console.error(
    'inject-csp-hashes: no script-src directive found in build/_headers — nothing rewritten.',
  )
  process.exit(1)
}

writeFileSync(headersPath, headers)
console.log(
  `inject-csp-hashes: OK — injected ${hashTokens.length} inline-script hash(es) into ${replaced} CSP header(s) across ${htmlFiles.length} page(s)`,
)
