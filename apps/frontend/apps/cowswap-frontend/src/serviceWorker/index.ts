// Disable workbox verbose logging
declare const self: ServiceWorkerGlobalScope & { __WB_DISABLE_DEV_LOGS?: boolean }
self.__WB_DISABLE_DEV_LOGS = true

import 'workbox-precaching' // defines __WB_MANIFEST

import { clientsClaim, setCacheNameDetails } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { PrecacheEntry } from 'workbox-precaching/_types'
import { registerRoute, Route } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

import { DocumentRoute } from './document'
import { toURL } from './utils'

import pkg from '../../package.json'

const WEB_VERSION = pkg.version

// The precache manifest (injected by workbox at build time) lists every asset with
// its content revision, so it changes on every deploy — even when package.json's
// version does not. Capture it ONCE here — this is the single injection point
// workbox's injectManifest replaces (it requires exactly one), so the reduce below
// reuses this captured value instead of referencing the placeholder again.
const precacheManifest = self.__WB_MANIFEST

// Fold the manifest into a short, deploy-specific build id. It is appended to the
// cache suffix so each build gets a DISTINCT precache name. Without it, two builds
// that share package.json's version also share the name "Ophis-precache-v2-<ver>";
// cleanupOutdatedCaches() then treats that name as still-current and never purges
// it, so a stale/corrupt same-version precache survives and can leave the app
// stuck on the #ophis-seo fallback until the user manually clears site data.
const buildId = ((): string => {
  let h = 5381
  for (const entry of precacheManifest) {
    const s = typeof entry === 'string' ? entry : `${entry.url}|${entry.revision ?? ''}`
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
})()

// Set Cache name
//  See https://dev.to/atonchev/flawless-and-silent-upgrade-of-the-service-worker-2o95
setCacheNameDetails({
  prefix: 'Ophis',
  suffix: `${WEB_VERSION}-${buildId}`,
})

clientsClaim()
self.skipWaiting()

// Now that each deploy has a distinct cache name (build id above), this purges the
// previous deploy's precache on activate, keeping the skipWaiting()+clientsClaim()
// takeover clean instead of leaving stale caches to accumulate.
cleanupOutdatedCaches()

const excludedAssets = ['emergency.js']

// Registers the document route for the precached document.
// This must be done before setting up workbox-precaching, so that it takes precedence.
registerRoute(new DocumentRoute())

// Splits entries into assets, which are loaded on-demand; and entries, which are precached.
// Effectively, this precaches the document, and caches all other assets on-demand.
const { assets, entries } = precacheManifest.reduce<{ assets: { [key: string]: boolean }; entries: PrecacheEntry[] }>(
  (acc, entry) => {
    const { assets, entries } = acc

    if (typeof entry === 'string') {
      assets[entry] = true
    } else if (entry.revision) {
      if (!excludedAssets.includes(entry.url)) {
        entries.push(entry)
      }
    } else {
      assets[toURL(entry)] = true
    }

    return acc
  },
  { assets: {}, entries: [] },
)

// Registers the assets' routes for on-demand caching.
registerRoute(
  new Route(
    ({ url }) => assets[url.pathname.slice(1)],
    new CacheFirst({
      cacheName: 'assets',
      plugins: [new ExpirationPlugin({ maxEntries: 16 })],
    }),
  ),
)

// Precaches entries and registers a default route to serve them.
precacheAndRoute(entries)
