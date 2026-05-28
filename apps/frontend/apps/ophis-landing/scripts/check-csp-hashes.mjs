#!/usr/bin/env node
/**
 * Build-time CSP hash verifier.
 * Reads dist/index.html, computes SHA-256 of every inline <script> block,
 * then verifies each hash appears in public/_headers.
 * Exits 1 (fails CI) if any hash is missing — prevents silent CSP drift.
 *
 * Run after `astro build`: node scripts/check-csp-hashes.mjs
 */

import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const html = readFileSync(resolve(root, 'dist/index.html'), 'utf8')
const headers = readFileSync(resolve(root, 'public/_headers'), 'utf8')

// Extract all inline script bodies (both plain and type=module inline blocks).
// Linear pattern: [^>]* skips attributes without nested quantifiers (no ReDoS),
// [\s\S]*? is lazy (linear), and \/script\s*> is a fixed closing literal.
// CodeQL js/bad-tag-filter is satisfied because the closing tag is the literal
// string "</script>" — not a wildcard.  We control the input (our own Astro
// build output), so no exotic attribute values with embedded ">" are expected,
// and the simpler pattern is both safe and sufficient.
const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
let m
const hashes = []
while ((m = scriptRe.exec(html)) !== null) {
  const body = m[1]
  if (!body.trim()) continue
  const hash = "sha256-" + createHash('sha256').update(body).digest('base64')
  hashes.push(hash)
}

if (hashes.length === 0) {
  console.error('check-csp-hashes: no inline scripts found in dist/index.html — check the build.')
  process.exit(1)
}

let failed = false
for (const hash of hashes) {
  if (!headers.includes(`'${hash}'`)) {
    console.error(`check-csp-hashes: MISSING hash in _headers: '${hash}'`)
    failed = true
  }
}

if (failed) {
  console.error('\nRun the following to regenerate hashes:')
  console.error('  node scripts/check-csp-hashes.mjs --print')
  process.exit(1)
}

console.log(`check-csp-hashes: OK — ${hashes.length} inline script hashes verified in _headers`)
