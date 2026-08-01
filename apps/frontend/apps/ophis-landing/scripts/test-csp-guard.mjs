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
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

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

test('rejects a sha384 hash with no matching script in dist', { skip: !distExists && 'run astro build first' }, () => {
  // CSP accepts sha256/384/512. Matching only sha256 meant a hash pasted from a
  // violation report in another algorithm was invisible and the guard passed.
  const r = runWith(addToScriptSrc('sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))
  assert.equal(r.code, 1)
  assert.match(r.out, /no inline script in dist produces this hash/)
})

test('rejects a sha512 hash with no matching script in dist', { skip: !distExists && 'run astro build first' }, () => {
  const r = runWith(addToScriptSrc('sha512-' + 'B'.repeat(86) + '=='))
  assert.equal(r.code, 1)
  assert.match(r.out, /no inline script in dist produces this hash/)
})

test('ACCEPTS a sha384 hash that a real dist script produces', { skip: !distExists && 'run astro build first' }, () => {
  // The algorithm widening must not become "reject anything non-sha256": a
  // legitimate sha384 entry for a script we actually ship has to pass.
  const { createHash } = require('node:crypto')
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
  const m = /<script(?![^>]*\bsrc=)(?![^>]*type="(?:application\/ld\+json|importmap|speculationrules)")[^>]*>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'expected at least one inline script in dist/index.html')
  const sha384 = 'sha384-' + createHash('sha384').update(m[1]).digest('base64')
  const r = runWith(addToScriptSrc(sha384))
  assert.equal(r.code, 0, r.out)
})

test("rejects 'unsafe-inline' in default-src when it is the only script directive", { skip: !distExists && 'run astro build first' }, () => {
  // default-src is the FIRST directive, so the old regex (anchored on ^ or ;)
  // never saw it and the fallback check silently did nothing.
  // Fold script-src's contents (hashes included, so the MISSING-hash check
  // still passes) into default-src, drop script-src, and weaken default-src.
  const r = runWith((h) => {
    const m = /script-src ([^;]*);/.exec(h)
    assert.ok(m, 'expected a script-src directive to relocate')
    return h
      .replace(/script-src [^;]*;/, '')
      .replace("default-src 'self'", `default-src 'self' 'unsafe-inline' ${m[1]}`)
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /unsafe-inline' in default-src/)
})

test('rejects the base64url spelling of an unbacked hash', { skip: !distExists && 'run astro build first' }, () => {
  // CSP's base64-value grammar allows -/_ as well as +/. A browser decodes
  // 'sha256-zjLSe-Ifl…' and 'sha256-zjLSe+Ifl…' to the SAME digest, so matching
  // only the standard alphabet let the base64url form of a Cloudflare hash
  // through while this guard passed.
  const b64url = 'zjLSe+IflcBnH+CRkSBSMcUK03hIJ1iKjyFreRtwze4='.replace(/\+/g, '-').replace(/\//g, '_')
  const r = runWith(addToScriptSrc(`sha256-${b64url}`))
  assert.equal(r.code, 1)
  assert.match(r.out, /Cloudflare Tag Gateway|no inline script in dist produces this hash/)
})

test('ACCEPTS the base64url spelling of a hash dist really produces', { skip: !distExists && 'run astro build first' }, () => {
  // Canonicalising must not turn into "reject anything with -/_".
  const { createHash } = require('node:crypto')
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
  const m = /<script(?![^>]*\bsrc=)(?![^>]*type="(?:application\/ld\+json|importmap|speculationrules)")[^>]*>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'expected an inline script in dist/index.html')
  const std = createHash('sha256').update(m[1]).digest('base64')
  const url = std.replace(/\+/g, '-').replace(/\//g, '_')
  const r = runWith(addToScriptSrc(`sha256-${url}`))
  assert.equal(r.code, 0, r.out)
})

test('rejects a duplicate script-src whose FIRST copy is permissive', { skip: !distExists && 'run astro build first' }, () => {
  // Browsers enforce the first occurrence and ignore later ones, so a
  // last-wins parse would have read the strict copy and passed.
  const r = runWith((h) =>
    h.replace(/script-src /, "script-src 'self' 'unsafe-inline'; script-src "),
  )
  assert.equal(r.code, 1)
  assert.match(r.out, /unsafe-inline' in script-src/)
  assert.match(r.out, /duplicate 'script-src' directive/)
})

test('ACCEPTS a shipped script whose ONLY entry is the base64url spelling', { skip: !distExists && 'run astro build first' }, () => {
  // REPLACES the standard entry rather than adding beside it. The earlier
  // acceptance test added one, so the standard spelling still satisfied the
  // dist->headers check and the missing canonicalisation on that side stayed
  // hidden: a legitimate base64url-only policy was reported as MISSING.
  const r = runWith((h) =>
    h.replace(/'sha256-([A-Za-z0-9+/=]+)'/, (_m, b64) => `'sha256-${b64.replace(/\+/g, '-').replace(/\//g, '_')}'`),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /check-csp-hashes: OK/)
})

test('still reports a genuinely missing hash when an entry is deleted', { skip: !distExists && 'run astro build first' }, () => {
  // Guard against the above turning into "accept anything": deletion must fail.
  const r = runWith((h) => h.replace(/'sha256-[A-Za-z0-9+/=]+'\s?/, ''))
  assert.equal(r.code, 1)
  assert.match(r.out, /MISSING hash in _headers/)
})
