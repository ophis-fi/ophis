#!/usr/bin/env node
/**
 * Regression coverage for the CSP weakening guard in check-csp-hashes.mjs.
 *
 * The guard exists because production logs two script-src-elem violations that
 * are NOT ours: Cloudflare's Google Tag Gateway injects a duplicate,
 * consent-unaware GA4 setup at the edge. Whitelisting those hashes to silence
 * the console would double-count page_views and configure GA4 before EEA
 * consent, so the guard has to make that the failing path.
 *
 * It runs the real script against a temporary copy of the app (dist + a mutated
 * _headers), because the guard reads both from disk. Each case asserts the exit
 * code AND that the message names the right thing - a guard that fails for the
 * wrong reason is not covered.
 *
 * Requires `astro build` to have run. Run: node scripts/test-csp-guard.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const distExists = existsSync(join(root, 'dist'))

/** Run the guard in a sandbox whose _headers has been transformed. */
function runWith(transform) {
  const box = mkdtempSync(join(tmpdir(), 'csp-guard-'))
  try {
    cpSync(join(root, 'dist'), join(box, 'dist'), { recursive: true })
    cpSync(join(root, 'scripts'), join(box, 'scripts'), { recursive: true })
    cpSync(join(root, 'public/_headers'), join(box, 'public/_headers'), { recursive: true })
    const hp = join(box, 'public/_headers')
    writeFileSync(hp, transform(readFileSync(hp, 'utf8')))
    try {
      const out = execFileSync(process.execPath, [join(box, 'scripts/check-csp-hashes.mjs')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, out }
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
}

const CF_MARKER = 'sha256-zjLSe+IflcBnH+CRkSBSMcUK03hIJ1iKjyFreRtwze4='
const addToScriptSrc = (extra) => (h) => h.replace("script-src 'self'", `script-src 'self' '${extra}'`)

test('passes on the real, pruned _headers', { skip: !distExists && 'run astro build first' }, () => {
  const r = runWith((h) => h)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /check-csp-hashes: OK/)
})

test("rejects Cloudflare's known edge-injected hash", { skip: !distExists && 'run astro build first' }, () => {
  const r = runWith(addToScriptSrc(CF_MARKER))
  assert.equal(r.code, 1)
  assert.match(r.out, /Cloudflare Tag Gateway/)
})

test('rejects an UNKNOWN hash too, so a changed CF snippet cannot slip in', { skip: !distExists && 'run astro build first' }, () => {
  // The whole point of deriving the allowlist from dist: CF can change its
  // snippet without touching this repo, producing a hash no denylist knows.
  const r = runWith(addToScriptSrc('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='))
  assert.equal(r.code, 1)
  assert.match(r.out, /no inline script in dist produces this hash/)
})

test("rejects 'unsafe-inline' in script-src", { skip: !distExists && 'run astro build first' }, () => {
  const r = runWith(addToScriptSrc('unsafe-inline'))
  assert.equal(r.code, 1)
  assert.match(r.out, /unsafe-inline' in script-src/)
})

test("rejects 'unsafe-inline' in script-src-elem beside a strict script-src", { skip: !distExists && 'run astro build first' }, () => {
  // script-src-elem takes precedence over script-src for <script> ELEMENTS, so
  // checking script-src alone let this through.
  const r = runWith((h) => h.replace('; style-src', "; script-src-elem 'self' 'unsafe-inline'; style-src"))
  assert.equal(r.code, 1)
  assert.match(r.out, /unsafe-inline' in script-src-elem/)
  assert.match(r.out, /governs <script> elements/)
})

test('still catches a dist script missing from _headers', { skip: !distExists && 'run astro build first' }, () => {
  // The original one-directional check must keep working.
  const r = runWith((h) => h.replace(/'sha256-[A-Za-z0-9+/=]+'\s?/, ''))
  assert.equal(r.code, 1)
  assert.match(r.out, /MISSING hash in _headers/)
})
