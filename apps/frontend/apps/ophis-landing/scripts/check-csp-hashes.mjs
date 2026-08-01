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

// --- CSP weakening guard --------------------------------------------------
//
// The check above is one-directional (every dist hash must be in _headers), so
// stale hashes accumulate forever: each edit to an inline script added a new
// hash and never removed the old one. Six had built up by 2026-08-01, from PRs
// #320, #368, #374, #385, #553 and #557. Every stale hash silently keeps a
// script body executable that the site no longer ships, and - worse - it makes
// "is this hash legitimate?" unanswerable, which is the hole an attacker or a
// well-meaning console-noise fix walks through.
//
// So the rule is now bidirectional: an inline hash may appear in _headers ONLY
// if a script with that hash is actually emitted into dist. That is an
// allowlist derived from the build, which needs no hardcoded third-party
// hashes and therefore does not rot when the third party changes its snippet.
//
// Concretely it rejects Cloudflare's Google Tag Gateway scripts. CF rewrites
// the HTML at the edge for browser-like requests (curl 91,129 bytes vs Chrome
// UA 91,545), injecting a duplicate, consent-unaware GA4 setup that runs BEFORE
// our own hashed block in Base.astro and calls gtag('config') with no consent
// defaults. They are correctly blocked in production; whitelisting them to
// silence the console would double-count page_views and set analytics cookies
// before EEA opt-in. Because the rule is derived from dist, it catches those
// two hashes AND any future variant of them.
const KNOWN_THIRD_PARTY = {
  'sha256-zjLSe+IflcBnH+CRkSBSMcUK03hIJ1iKjyFreRtwze4=': 'Cloudflare Tag Gateway first-party marker',
  'sha256-DB1UU0B/mr+5VxNTIplcok5EhFglyp9QTt4EpZxLem4=': 'Cloudflare Tag Gateway gtag config (no consent defaults)',
}

const weakened = []

// 1. Every inline hash in _headers must be backed by a script in dist.
const headerHashes = [...headers.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1])
for (const hash of new Set(headerHashes)) {
  if (seen.has(hash)) continue
  const known = KNOWN_THIRD_PARTY[hash]
  weakened.push(
    known
      ? `${hash} — ${known}: edge-injected, never in dist, must stay blocked`
      : `${hash} — no inline script in dist produces this hash (stale, or pasted from a CSP report)`,
  )
}

// 2. 'unsafe-inline' in ANY directive that governs <script> ELEMENTS. Checking
//    script-src alone was insufficient: script-src-elem takes precedence over
//    script-src for script elements, so a permissive script-src-elem next to a
//    strict script-src would have passed.
const directiveValue = (name) =>
  new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`, 'i').exec(headers)?.[1] ?? null
const scriptSrc = directiveValue('script-src')
const scriptSrcElem = directiveValue('script-src-elem')
const defaultSrc = directiveValue('default-src')
// Precedence for <script> elements: script-src-elem > script-src > default-src.
const effective =
  scriptSrcElem !== null
    ? ['script-src-elem', scriptSrcElem]
    : scriptSrc !== null
      ? ['script-src', scriptSrc]
      : defaultSrc !== null
        ? ['default-src', defaultSrc]
        : null
if (effective && /'unsafe-inline'/.test(effective[1])) {
  weakened.push(`'unsafe-inline' in ${effective[0]} (the directive that governs <script> elements here)`)
}
// Flag it in the non-effective ones too: harmless today, a trap the next time
// the directives are reordered.
for (const [name, value] of [['script-src', scriptSrc], ['script-src-elem', scriptSrcElem], ['default-src', defaultSrc]]) {
  if (value !== null && /'unsafe-inline'/.test(value) && effective?.[0] !== name) {
    weakened.push(`'unsafe-inline' in ${name} (not effective for script elements today, but remove it)`)
  }
}

if (weakened.length) {
  console.error('check-csp-hashes: CSP WEAKENED — refusing to pass:\n')
  for (const w of weakened) console.error(`  - ${w}`)
  console.error(
    '\nAn inline hash belongs in _headers only while a script in dist produces it.\n' +
      "To silence Cloudflare's edge-injected gtag violations, disable AUTOMATIC\n" +
      'INJECTION for Google tag gateway on the ophis.fi zone in the Cloudflare\n' +
      'dashboard — not by adding hashes here.\n',
  )
  process.exit(1)
}

console.log(
  `check-csp-hashes: OK — ${seen.size} distinct executable inline-script hash(es) verified across ${htmlFiles.length} page(s)`,
)
