import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const frontend = new URL('../../frontend/apps/cowswap-frontend/', import.meta.url)
const emergency = readFileSync(new URL('public/emergency.js', frontend), 'utf8')

function browser(pathname: string) {
  const values = new Map([['tokens:lastUpdateTimeAtom:v6', 'seen']])
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
  const indexedDB = {
    databases: async () => ['legacy-token-db', 'level-js-ophisRailgunEthereum:v0', 'level-js-ophisRailgunEthereumPreferences:v0']
      .map((name) => ({ name })),
    deleteDatabase: vi.fn(),
  }
  const caches = {
    keys: async () => ['assets', 'ophisRailgunArtifacts:v0'],
    delete: vi.fn().mockResolvedValue(true),
  }
  const location = { hostname: 'swap.ophis.fi', host: 'swap.ophis.fi', pathname, search: '', hash: '#/1/swap/_/_', reload: vi.fn(), replace: vi.fn() }
  const document = { cookie: '', createElement: () => ({}), head: { appendChild: vi.fn() } }
  const context = {
    window: { location, caches }, document, location, indexedDB, caches, localStorage,
    sessionStorage: { clear: vi.fn() }, navigator: {}, console: { log: vi.fn(), error: vi.fn() },
    fetch: async () => ({ json: async () => ({ resetCacheInCaseOfEmergency: false }) }),
  }
  return { context, indexedDB, caches, location, document }
}

it('preserves encrypted wallet, metadata, journals and proof artifacts during the old public storage migration', async () => {
  const fixture = browser('/')
  runInNewContext(emergency, fixture.context)
  await vi.waitFor(() => expect(fixture.location.reload).toHaveBeenCalledOnce())
  expect(fixture.indexedDB.deleteDatabase.mock.calls).toEqual([['legacy-token-db']])
  expect(fixture.caches.delete.mock.calls).toEqual([['assets']])
})

it('enters a fresh private document without running destructive migrations and installs an early script policy', async () => {
  const fixture = browser('/private-swap/')
  runInNewContext(emergency, fixture.context)
  await Promise.resolve()
  expect(fixture.indexedDB.deleteDatabase).not.toHaveBeenCalled()
  expect(fixture.document.head.appendChild).toHaveBeenCalledWith(expect.objectContaining({
    httpEquiv: 'Content-Security-Policy', content: expect.stringContaining("script-src 'self'"),
  }))
  expect(fixture.location.replace).not.toHaveBeenCalled()
})

it('uses the same supplied incognito geometry in the main app and the execution card', () => {
  const svg = readFileSync(new URL('../public/incognito.svg', import.meta.url), 'utf8')
  const path = / d="([^"]+)"/.exec(svg)?.[1]
  expect(path).toBeTruthy()
  const component = readFileSync(new URL('src/ophis/components/IncognitoIcon.pure.tsx', frontend), 'utf8')
  expect(component).toContain(`d="${path}"`)
})
