#!/usr/bin/env node
/**
 * Ping IndexNow to request a fast recrawl of changed URLs by Bing / Yandex /
 * Seznam (and other IndexNow participants). Run from CI after a content deploy.
 *
 * Usage:  node scripts/indexnow-ping.mjs <host> <url> [<url> ...]
 *   e.g.  node scripts/indexnow-ping.mjs ophis.fi https://ophis.fi/
 *
 * The key is PUBLIC and hosted at https://<host>/<key>.txt (see the
 * <key>.txt files committed in each surface's web root). This is NOT a secret.
 *
 * Non-fatal by design: any failure logs and exits 0 so it can never block a
 * deploy. All URLs must be on <host> (IndexNow rejects cross-host batches).
 */

const KEY = '87363f03a1714c85a011bd1001cdec15'

const [host, ...urls] = process.argv.slice(2)

if (!host || urls.length === 0) {
  console.error('usage: node scripts/indexnow-ping.mjs <host> <url> [<url> ...]')
  process.exit(0)
}

// Guard: every URL must be on <host> or IndexNow rejects the whole batch.
const offHost = urls.filter((u) => {
  try {
    return new URL(u).host !== host
  } catch {
    return true
  }
})
if (offHost.length > 0) {
  console.error(`IndexNow: skipping, these URLs are not on ${host}: ${offHost.join(', ')}`)
  process.exit(0)
}

const body = {
  host,
  key: KEY,
  keyLocation: `https://${host}/${KEY}.txt`,
  urlList: urls,
}

// Bound the request: if IndexNow accepts the connection but stalls, an
// unbounded fetch would hang the deploy step past `continue-on-error` until the
// runner/network timeout, delaying or skipping later steps (e.g. build
// provenance). Abort after 10s.
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 10_000)

try {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  // 200 = accepted, 202 = accepted pending validation. Anything else is logged
  // but never fails the deploy.
  console.log(`IndexNow ${host}: HTTP ${res.status} for ${urls.length} url(s)`)
} catch (err) {
  const reason = controller.signal.aborted ? 'timed out after 10s' : err?.message ?? err
  console.error(`IndexNow ${host}: ping failed (non-fatal):`, reason)
} finally {
  clearTimeout(timeout)
}

process.exit(0)
